import { createHash, randomBytes } from 'node:crypto';

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
 * @param {State} state
 * @param {{repo: string, note: string, snapshot: Snapshot, port: number, now: number}} input
 * @returns {{session: Session, reused: boolean}}
 */
export const openOrReuse = (state, { repo, note, snapshot, port, now }) => {
  const key = sessionKey(repo);
  const at = new Date(now).toISOString();
  const existing = state.sessions[key];

  if (existing && existing.status === 'open') {
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
    url: sessionUrl(key, token, port),
    status: 'open',
    closedBy: null,
    note,
    snapshot,
    snapshotAt: at,
    comments: [],
    chat: [],
    lease: null,
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
