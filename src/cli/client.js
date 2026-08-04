import { spawn } from 'node:child_process';
import { readFile, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { serverPath } from '../paths.js';
import { readServerFile, findPort, DEFAULT_PORT } from '../server/index.js';

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

/** How long a start lock may sit before it is treated as abandoned. */
const START_LOCK_MS = 5000;
const lockPath = () => `${serverPath()}.lock`;

/**
 * Claims the exclusive right to start a daemon. Without this, two `cr` processes
 * beginning while no daemon is recorded each start one, and since the daemon
 * writes server.json itself the last write wins and the loser is left listening
 * forever with nothing referencing it. That is how a port range fills with
 * strays: eight were found on one machine, one per open.
 * @returns {Promise<boolean>} Whether this process may start a daemon.
 */
const takeStartLock = async () => {
  await mkdir(dirname(lockPath()), { recursive: true, mode: 0o700 });
  try {
    await writeFile(lockPath(), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    // A starter that died holding the lock must not wedge every later
    // invocation, so an old one is taken rather than waited on.
    try {
      if (Date.now() - (await stat(lockPath())).mtimeMs > START_LOCK_MS) {
        await rm(lockPath(), { force: true });
        return await takeStartLock();
      }
    } catch {
      // It vanished under us, which means the winner finished: fall through.
    }
    return false;
  }
};

/**
 * Waits for whoever holds the start lock to record a usable daemon.
 * @returns {Promise<number|null>} The port, or null if none appeared in time.
 */
const awaitStartedDaemon = async () => {
  const deadline = Date.now() + START_LOCK_MS + 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const recorded = await readServerFile();
    if (recorded) {
      const live = await probe(recorded.port);
      if (live.ok && live.version === pkg.version) return recorded.port;
    }
  }
  return null;
};

/**
 * Discovers or starts the server, replacing one that predates this CLI.
 * @returns {Promise<number>} The port to talk to.
 */
export const ensureServer = async () => {
  const recorded = await readServerFile();

  if (recorded) {
    const live = await probe(recorded.port);
    if (live.ok && live.version === pkg.version) return recorded.port;
    if (live.ok) {
      await shutdown(recorded.port, live.pid ?? recorded.pid);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await rm(serverPath(), { force: true });
  }

  // Exactly one process starts a daemon; the others wait for it to be recorded
  // and share it.
  if (!(await takeStartLock())) {
    const shared = await awaitStartedDaemon();
    if (shared !== null) return shared;
    // The holder never produced one, so start it here after all: no daemon is
    // worse than a second attempt.
  }

  // findPort proves a port free by binding, then releases it, so a concurrent
  // starter can take it first. Retry rather than failing the command, and keep
  // findPort inside the try: under parallel starts every port can look busy for
  // an instant, and that must be retried too rather than escaping the loop.
  /** @type {unknown} */
  let lastErr;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const port = await findPort(DEFAULT_PORT);
        await spawnDaemon(port);
        return port;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  } finally {
    // Released whether we succeeded or gave up, or the next invocation waits
    // out the full staleness window for nothing.
    await rm(lockPath(), { force: true });
  }

  throw lastErr;
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
