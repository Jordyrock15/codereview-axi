import { StateError } from '../state/errors.js';

/** @typedef {import('../types.js').Session} Session */

export const LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Whether a pid is still running. Signal 0 checks for existence without
 * delivering anything; EPERM means the process is there but owned by someone
 * else, which still counts as alive.
 * @param {number} pid
 * @returns {boolean}
 */
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
};

/**
 * @param {Session} session
 * @param {number} now
 * @returns {number|null}
 */
export const leaseHolder = (session, now) => {
  if (!session.lease) return null;
  if (Date.parse(session.lease.expiresAt) <= now) return null;
  // A poll may legitimately run for the full TTL, so the clock alone cannot
  // tell a live holder from a killed one. The holder is a local pid (the
  // server is loopback-only), so its absence is proof the lease is abandoned;
  // without this, one killed `cr wait` locks the session out for 15 minutes.
  //
  // Presence is not proof of the reverse: if the OS has recycled a killed
  // waiter's pid, an unrelated process reads as the holder and the lease stays
  // locked until it expires. That is the old behaviour in a much narrower case,
  // and distinguishing it needs the process start time, not just the pid.
  return alive(session.lease.holder) ? session.lease.holder : null;
};

/**
 * Claims exclusive right to receive this session's sent comments.
 * @param {Session} session
 * @param {number} holder
 * @param {number} now
 * @param {number} ttlMs
 * @returns {{holder: number, expiresAt: string}}
 */
export const takeLease = (session, holder, now, ttlMs = LEASE_TTL_MS) => {
  const current = leaseHolder(session, now);
  if (current !== null && current !== holder) {
    throw new StateError(409, `another agent is waiting on this session (pid ${current})`);
  }

  session.lease = { holder, expiresAt: new Date(now + ttlMs).toISOString() };
  return session.lease;
};

/**
 * @param {Session} session
 * @param {number} holder
 * @returns {void}
 */
export const releaseLease = (session, holder) => {
  if (session.lease && session.lease.holder === holder) session.lease = null;
};
