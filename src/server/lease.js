import { StateError } from '../state/errors.js';

/** @typedef {import('../types.js').Session} Session */

export const LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * @param {Session} session
 * @param {number} now
 * @returns {number|null}
 */
export const leaseHolder = (session, now) => {
  if (!session.lease) return null;
  return Date.parse(session.lease.expiresAt) > now ? session.lease.holder : null;
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
