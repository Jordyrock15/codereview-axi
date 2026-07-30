import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { serverPath } from '../paths.js';
import { readServerFile, findPort, DEFAULT_PORT } from '../server/index.js';

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

/** Carries a CLI exit code. */
export class CliError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
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
 * @param {number} port
 * @returns {Promise<void>}
 */
const waitForHealth = async (port) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await probe(port)).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new CliError(3, `server did not come up on port ${port}`);
};

/**
 * @param {number} port
 * @returns {Promise<void>}
 */
const spawnDaemon = async (port) => {
  const entry = new URL('../server/daemon.js', import.meta.url);
  const child = spawn(process.execPath, [entry.pathname], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CR_PORT: String(port) },
  });
  child.unref();
  await waitForHealth(port);
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

  // findPort proves a port free by binding, then releases it, so a concurrent
  // starter can take it first. Retry rather than failing the command.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await findPort(DEFAULT_PORT);
    try {
      await spawnDaemon(port);
      return port;
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }

  throw new CliError(3, 'could not start a cr server');
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
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === undefined ? {} : { 'x-cr-token': token }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? null : JSON.parse(text) };
  } catch {
    throw new CliError(3, 'cannot reach the cr server');
  }
};
