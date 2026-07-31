import { createHash, randomBytes } from 'node:crypto';
import { StateError } from './errors.js';

/**
 * @typedef {import('../types.js').Session} Session
 * @typedef {import('../types.js').Snapshot} Snapshot
 * @typedef {{sessions: Record<string, Session>}} State
 */

export const REAP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Identity of a session: the worktree it reviews.
 * @param {string} toplevel
 * @returns {string}
 */
export const sessionKey = (toplevel) => createHash('sha256').update(toplevel).digest('hex').slice(0, 16);

/**
 * The access secret, deliberately unrelated to the key, which is guessable.
 * @returns {string}
 */
export const mintToken = () => randomBytes(32).toString('hex');

/**
 * @param {string} key
 * @param {string} token
 * @param {number} port
 * @returns {string}
 */
export const sessionUrl = (key, token, port) => `http://127.0.0.1:${port}/session/${key}?t=${token}`;

/**
 * Comments are anchored to a review surface; swapping the base or PR under
 * them would leave them pointing at a different comparison. Exported so a
 * route can run the same check before doing the work of building a snapshot,
 * without risking drift from the authoritative check `openOrReuse` runs.
 * @param {Session|null|undefined} existing
 * @param {string} [base]
 * @param {number|null} [pr]
 * @returns {void}
 */
export const assertNoBaseConflict = (existing, base, pr) => {
  if (!existing || existing.status !== 'open') return;
  if (base !== undefined && base !== existing.base) {
    throw new StateError(409, `session is already open with base ${existing.base ?? 'the working tree'}, cannot switch to ${base}`);
  }
  if (pr !== undefined && pr !== existing.pr) {
    const incumbent = existing.pr != null ? `PR ${existing.pr}` : `base ${existing.base ?? 'the working tree'}`;
    throw new StateError(409, `session is already open with ${incumbent}, cannot switch to PR ${pr}`);
  }
};

/**
 * @param {State} state
 * @param {{repo: string, note: string, snapshot: Snapshot, port: number, now: number, base?: string, pr?: number|null}} input
 * @returns {{session: Session, reused: boolean}}
 */
export const openOrReuse = (state, {
  repo, note, snapshot, port, now, base, pr,
}) => {
  const key = sessionKey(repo);
  const at = new Date(now).toISOString();
  const existing = state.sessions[key];
  assertNoBaseConflict(existing, base, pr);

  if (existing && existing.status === 'open') {
    // Sessions created before `pr` existed are pr-less in memory; normalise
    // to the number|null contract without disturbing the reopen rules above.
    existing.pr ??= pr ?? null;
    // A bare `cr open` sends no note; that must not wipe one set earlier.
    if (note !== '') existing.note = note;
    existing.snapshot = snapshot;
    existing.snapshotAt = at;
    existing.updatedAt = at;
    existing.url = sessionUrl(key, existing.token, port);
    return { session: existing, reused: true };
  }

  const token = mintToken();
  /** @type {Session} */
  const session = {
    key,
    token,
    repo,
    base: base ?? null,
    pr: pr ?? null,
    url: sessionUrl(key, token, port),
    status: 'open',
    closedBy: null,
    note,
    snapshot,
    snapshotAt: at,
    comments: [],
    chat: [],
    lease: null,
    view: 'unified',
    createdAt: at,
    updatedAt: at,
  };

  state.sessions[key] = session;
  return { session, reused: false };
};

/**
 * @param {Session} session
 * @param {'human'|'agent'} closedBy
 * @param {number} now
 * @returns {Session}
 */
export const closeSession = (session, closedBy, now) => {
  session.status = 'closed';
  session.closedBy = closedBy;
  session.lease = null;
  session.updatedAt = new Date(now).toISOString();
  return session;
};

/**
 * Closes abandoned sessions so a forgotten one cannot be resumed weeks later.
 * @param {State} state
 * @param {number} now
 * @param {number} [maxAgeMs]
 * @returns {string[]} Keys that were closed.
 */
export const reapSessions = (state, now, maxAgeMs = REAP_AFTER_MS) => {
  /** @type {string[]} */
  const closed = [];
  for (const session of Object.values(state.sessions)) {
    if (session.status !== 'open') continue;
    if (now - Date.parse(session.updatedAt) <= maxAgeMs) continue;
    closeSession(session, 'agent', now);
    closed.push(session.key);
  }
  return closed;
};
