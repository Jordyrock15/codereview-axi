import { StateError } from '../state/errors.js';

const BODY_LIMIT = 2 * 1024 * 1024;

/**
 * @param {any} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
export const sendJson = (res, status, body) => {
  if (res.writableEnded || res.destroyed) return;

  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

/**
 * @param {any} req
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
export const readJson = async (req, limit = BODY_LIMIT) => {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new StateError(413, 'body too large');
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return null;

  try {
    return JSON.parse(raw);
  } catch {
    throw new StateError(400, 'body must be JSON');
  }
};

/**
 * @param {string} raw
 * @returns {string}
 */
const decodeSegment = (raw) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new StateError(400, 'malformed percent-escape in path');
  }
};

/**
 * @param {string} pattern
 * @param {string} pathname
 * @returns {Record<string, string>|null}
 */
const match = (pattern, pathname) => {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return null;

  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(':')) {
      params[expected[i].slice(1)] = decodeSegment(actual[i]);
      continue;
    }
    if (expected[i] !== actual[i]) return null;
  }
  return params;
};

/**
 * @typedef {{method: string, pattern: string, handler: (ctx: any) => Promise<{status?: number, body?: unknown}|void>}} Route
 */

/**
 * @param {any} req
 * @returns {URL}
 */
const parseTarget = (req) => {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  } catch {
    throw new StateError(400, 'malformed request target');
  }
};

/**
 * @param {Route[]} routes
 * @returns {(req: any, res: any) => Promise<void>}
 */
export const createRouter = (routes) => async (req, res) => {
  // A write to an aborted socket emits 'error'; with no listener Node throws.
  res.on('error', () => {});

  try {
    const url = parseTarget(req);
    let pathMatched = false;

    for (const route of routes) {
      const params = match(route.pattern, url.pathname);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;

      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : null;
      const result = await route.handler({ req, res, params, query: url.searchParams, body, url });
      if (res.headersSent) return;
      if (!result) {
        res.writeHead(204).end();
        return;
      }
      sendJson(res, result.status ?? 200, result.body ?? null);
      return;
    }

    sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method not allowed' : 'not found' });
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    // Two narrowed ternaries rather than one: err is unknown until narrowed.
    const status = err instanceof StateError ? err.status : 500;
    const message = err instanceof StateError ? err.message : 'internal error';
    sendJson(res, status, { error: message });
  }
};
