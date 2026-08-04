import { spawn } from 'node:child_process';
import { readFile, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { serverPath } from '../paths.js';
import { readServerFile, configuredPort, isFree } from '../server/index.js';

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

/** Carries a CLI exit code. */
export class CliError extends Error {
  /**
   * `code` is the process exit code, 1 for any error and 2 for an unknown flag.
   * `slug` is the stable machine-readable case, carrying what exit 2 and 3 used to.
   * @param {number} code
   * @param {string} message
   * @param {string} [slug]
   */
  constructor(code, message, slug = 'error') {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.slug = slug;
  }
}

/**
 * @param {number} port
 * @returns {Promise<{ok: boolean, version?: string, pid?: number}>}
 */
export const probe = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { ok: false };
    const body = await res.json();
    return { ok: body.ok === true, version: body.version, pid: body.pid };
  } catch {
    return { ok: false };
  }
};

/**
 * @param {number} port
 * @param {number} pid
 * @returns {Promise<void>}
 */
export const shutdown = async (port, pid) => {
  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Already gone, which is the outcome we wanted.
  }
};

/**
 * Starts a detached daemon and waits until that exact process answers health.
 * @param {number} port
 * @returns {Promise<void>}
 */
const spawnDaemon = async (port) => {
  // `URL.pathname` percent-encodes (a space becomes `%20`), which is not a
  // filesystem path: installed under a directory containing one, the daemon
  // would be spawned against a path that does not exist.
  const entry = fileURLToPath(new URL('../server/daemon.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CR_PORT: String(port) },
  });
  child.unref();

  let exited = false;
  child.once('exit', () => { exited = true; });
  // A spawn that never launches emits 'error', which is unhandled and fatal
  // on a ChildProcess, and does not reliably emit 'exit'.
  child.once('error', () => { exited = true; });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const live = await probe(port);
    // Identity matters: another daemon may already hold this port, and taking
    // its health as ours reports success for a server we did not start.
    if (live.ok && live.pid === child.pid) return;
    if (exited) throw new CliError(1, `the server on port ${port} exited before it was ready`, 'server-unreachable');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new CliError(1, `no server came up on port ${port}`, 'server-unreachable');
};

/**
 * @param {number} port
 * @param {number} withinMs
 * @returns {Promise<boolean>}
 */
const waitForPortFree = async (port, withinMs) => {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (await isFree(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await isFree(port);
};

/**
 * The pid listening on a port, when it is one of ours. Checked against the
 * command line as well as the port, so nothing else is ever signalled.
 * @param {number} port
 * @returns {Promise<number|null>}
 */
const crDaemonOnPort = (port) => new Promise((resolve) => {
  const lsof = spawn('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  lsof.stdout.on('data', (chunk) => { out += chunk; });
  lsof.once('error', () => resolve(null));
  lsof.once('close', () => {
    const pid = out.split('\n').map((line) => Number(line.trim())).find((n) => Number.isInteger(n) && n > 0);
    if (pid === undefined) { resolve(null); return; }

    const ps = spawn('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let cmd = '';
    ps.stdout.on('data', (chunk) => { cmd += chunk; });
    ps.once('error', () => resolve(null));
    ps.once('close', () => resolve(/codereview-axi|src\/server\/daemon\.js/.test(cmd) ? pid : null));
  });
});

/**
 * Discovers or starts the server, replacing one that predates this CLI.
 * @returns {Promise<number>} The port to talk to.
 */
export const ensureServer = async () => {
  const port = configuredPort();
  const live = await probe(port);

  if (live.ok && live.version === pkg.version) return port;

  if (live.ok) {
    // Ours, but a different version. Ask, then insist: a daemon that ignores
    // the request would otherwise hold the port and every command with it.
    await shutdown(port, live.pid ?? 0);
    if (!(await waitForPortFree(port, 2000)) && live.pid !== undefined) {
      try {
        process.kill(live.pid, 'SIGTERM');
      } catch {
        // Already gone, which is the outcome we wanted.
      }
      await waitForPortFree(port, 3000);
    }
  } else if (!(await isFree(port))) {
    // Something holds the port without answering our health check: a wedged
    // daemon of ours, or a stranger. Only ever signal our own, and say plainly
    // what to do about anything else rather than drifting to another port,
    // since silent drift is how a range fills with daemons nobody notices.
    const ours = await crDaemonOnPort(port);
    if (ours === null) {
      throw new CliError(1, `port ${port} is held by something that is not cr; free it or set CODEREVIEW_AXI_PORT`, 'state');
    }
    try {
      process.kill(ours, 'SIGTERM');
    } catch {
      // Raced with its own exit.
    }
    if (!(await waitForPortFree(port, 3000))) {
      throw new CliError(1, `a wedged cr daemon still holds port ${port}; kill pid ${ours} or set CODEREVIEW_AXI_PORT`, 'state');
    }
  }

  // The port is the mutex from here: concurrent starters all aim at it, the OS
  // lets one listen, and the losers find the winner through health below.
  await spawnDaemon(port).catch(() => {});

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await probe(port);
    if (health.ok && health.version === pkg.version) return port;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new CliError(1, `the cr server did not come up on port ${port}`, 'server-unreachable');
};

/**
 * @param {number} port
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [token]
 * @returns {Promise<{status: number, json: any}>}
 */
export const request = async (port, method, path, body, token) => {
  let res, text;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === undefined ? {} : { 'x-cr-token': token }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await res.text();
  } catch {
    throw new CliError(1, 'cannot reach the cr server', 'server-unreachable');
  }

  // The server answered, so it is not unreachable: the slug above is reserved
  // for a transport failure, not a body this CLI happens not to understand.
  try {
    return { status: res.status, json: text === '' ? null : JSON.parse(text) };
  } catch {
    throw new CliError(1, 'the cr server sent an unreadable response', 'bad-response');
  }
};
