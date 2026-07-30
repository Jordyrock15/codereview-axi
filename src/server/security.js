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
 * A malformed request target must deny, never throw out of the guard.
 * @param {string} url
 * @param {string} host
 * @returns {string}
 */
const queryToken = (url, host) => {
  try {
    return new URL(url, `http://${host}`).searchParams.get('t') ?? '';
  } catch {
    return '';
  }
};

/**
 * Host must be loopback on our port and any Origin must match. Split out so a
 * caller with no session yet (session creation) can run this check alone,
 * rather than faking a session to dodge the rest of `guard`.
 * @param {{headers: Record<string, string|string[]|undefined>, port: number}} input
 * @returns {GuardResult}
 */
export const checkOrigin = ({ headers, port }) => {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];

  const host = typeof headers.host === 'string' ? headers.host : '';
  if (!allowed.includes(host)) return deny(403, 'host not allowed');

  const origin = typeof headers.origin === 'string' ? headers.origin : '';
  if (origin !== '' && !allowed.some((entry) => origin === `http://${entry}`)) {
    return deny(403, 'origin not allowed');
  }

  return { ok: true };
};

/**
 * Gates every API request: Host and Origin as per `checkOrigin`, session must
 * exist, and the token must be exact.
 * @param {{headers: Record<string, string|string[]|undefined>, url: string, port: number, session: Session|null}} input
 * @returns {GuardResult}
 */
export const guard = ({ headers, url, port, session }) => {
  const originVerdict = checkOrigin({ headers, port });
  if (!originVerdict.ok) return originVerdict;

  if (!session) return deny(404, 'no such session');

  const host = typeof headers.host === 'string' ? headers.host : '';
  const header = headers['x-cr-token'];
  const fromHeader = typeof header === 'string' ? header : '';
  const token = fromHeader !== '' ? fromHeader : queryToken(url, host);

  if (token === '' || !sameSecret(token, session.token)) return deny(401, 'bad or missing token');

  return { ok: true };
};
