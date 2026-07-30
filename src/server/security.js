import { timingSafeEqual } from 'node:crypto';

/**
 * @typedef {import('../types.js').Session} Session
 * @typedef {{ok: true}|{ok: false, status: number, message: string}} GuardResult
 */

/**
 * @param {number} status
 * @param {string} message
 * @returns {GuardResult}
 */
const deny = (status, message) => ({ ok: /** @type {false} */ (false), status, message });

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
const sameSecret = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Gates every API request: session must exist, Host must be loopback on our
 * port, any Origin must match, and the token must be exact.
 * @param {{headers: Record<string, string|string[]|undefined>, url: string, port: number, session: Session|null}} input
 * @returns {GuardResult}
 */
export const guard = ({ headers, url, port, session }) => {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];

  const host = typeof headers.host === 'string' ? headers.host : '';
  if (!allowed.includes(host)) return deny(403, 'host not allowed');

  const origin = typeof headers.origin === 'string' ? headers.origin : '';
  if (origin !== '' && !allowed.some((entry) => origin === `http://${entry}`)) {
    return deny(403, 'origin not allowed');
  }

  if (!session) return deny(404, 'no such session');

  const header = headers['x-cr-token'];
  const fromHeader = typeof header === 'string' ? header : '';
  const fromQuery = new URL(url, `http://${host}`).searchParams.get('t') ?? '';
  const token = fromHeader !== '' ? fromHeader : fromQuery;

  if (token === '' || !sameSecret(token, session.token)) return deny(401, 'bad or missing token');

  return { ok: true };
};
