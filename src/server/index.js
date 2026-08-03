import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { homeDir, serverPath } from '../paths.js';
import { createApp } from './app.js';
import { sendJson } from './router.js';
import { checkOrigin } from './security.js';

export const DEFAULT_PORT = 4390;

/** @type {string|null} */
let cachedVersion = null;

/**
 * Read lazily so importing this module (every CLI command) does not pay for a
 * file read on commands that never start a server.
 * @returns {Promise<string>}
 */
const version = async () => {
  if (cachedVersion === null) {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    cachedVersion = String(JSON.parse(raw).version);
  }
  return cachedVersion;
};

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
const isFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, '127.0.0.1');
});

/**
 * @param {number} start
 * @param {number} [attempts]
 * @returns {Promise<number>}
 */
export const findPort = async (start, attempts = 20) => {
  for (let offset = 0; offset < attempts; offset += 1) {
    if (await isFree(start + offset)) return start + offset;
  }
  throw new Error(`no free port in ${start}..${start + attempts}`);
};

/** @returns {Promise<{pid: number, port: number, version: string}|null>} */
export const readServerFile = async () => {
  try {
    return JSON.parse(await readFile(serverPath(), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * @param {{pid: number, port: number, version: string}} info
 * @returns {Promise<void>}
 */
export const writeServerFile = async (info) => {
  await mkdir(homeDir(), { recursive: true, mode: 0o700 });
  await chmod(homeDir(), 0o700);
  await writeFile(serverPath(), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
};

/**
 * @param {{port?: number, now?: () => number}} [options]
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export const startServer = async (options = {}) => {
  const port = options.port ?? (await findPort(DEFAULT_PORT));
  // close is defined below, so the app gets an indirection rather than the
  // function itself. The app owns the delay and the re-check.
  /** @type {() => Promise<void>} */
  let stop = async () => {};
  const app = createApp({
    port,
    now: options.now,
    onIdle: () => { void stop(); },
  });
  const currentVersion = await version();

  const server = http.createServer((req, res) => {
    // Health and shutdown sit outside the router, so they miss its
    // aborted-socket guard; without this a disconnect mid-response throws.
    res.on('error', () => {});

    // Reuse the shared check rather than a second copy of the allow-list, so
    // these two routes cannot drift out of step with every guarded route.
    const verdict = checkOrigin({ headers: req.headers, port });
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.message });
      return;
    }

    const host = typeof req.headers.host === 'string' ? req.headers.host : '';

    /** @type {URL} */
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      sendJson(res, 400, { error: 'malformed request target' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version: currentVersion, pid: process.pid });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let pid = null;
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const parsed = raw.trim() === '' ? {} : JSON.parse(raw);
          pid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed.pid ?? null) : null;
        } catch {
          pid = null;
        }
        // Not an auth boundary: /api/health hands out this pid to any loopback
        // caller with no token. This only stops a blind or misdirected request,
        // not one that has deliberately read the pid first.
        if (pid !== process.pid) {
          sendJson(res, 403, { error: 'pid mismatch' });
          return;
        }
        sendJson(res, 200, { ok: true });
        setTimeout(() => { void close(); }, 50);
      });
      req.on('error', () => {});
      return;
    }

    void app.handler(req, res);
  });

  // The file must exist before anything can observe health, or a caller that
  // polls health and then reads server.json can find it missing.
  await writeServerFile({ pid: process.pid, port, version: currentVersion });

  try {
    server.listen(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (err) {
    await rm(serverPath(), { force: true });
    throw err;
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await rm(serverPath(), { force: true });
    await new Promise((resolve) => {
      server.close(() => resolve(undefined));
      // close() only stops new connections and then waits for open ones to end.
      // An SSE stream is keep-alive and never ends, so on its own this left a
      // daemon with a browser tab attached unreachable but still running: it had
      // removed its server.json and kept its port for the life of the tab.
      // Destroying beats waiting for the client to let go, since a tab on stale
      // assets or already gone at the OS level never will.
      server.closeAllConnections();
    });
  };

  stop = close;
  return { port, close };
};
