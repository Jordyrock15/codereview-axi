/**
 * @typedef {import('../../types.js').Session} Session
 */

/**
 * What the header's activity indicator should reflect: whether an agent has
 * picked up outstanding work, and whether one is on the wire right now.
 * These are independent axes rather than one ranked state, because a lease
 * can be held while any delivery state is true, most usefully while waiting.
 * @interface ActivityState
 * @typedef {Object} ActivityState
 * @property {'idle'|'waiting'|'working'} delivery — `idle` when no comment is `sent`, `waiting` when at least one sent comment has not been delivered, `working` when every sent comment has.
 * @property {boolean} polling — Whether the session currently holds an unexpired lease.
 */

/**
 * @param {Pick<Session, 'comments'|'lease'>} session
 * @param {number} [now] - Injected for deterministic expiry checks in tests.
 * @returns {ActivityState}
 */
export const activityState = (session, now = Date.now()) => {
  const sent = session.comments.filter((c) => c.status === 'sent');

  /** @type {'idle'|'waiting'|'working'} */
  let delivery = 'idle';
  if (sent.length > 0) {
    delivery = sent.some((c) => c.deliveredAt === null) ? 'waiting' : 'working';
  }

  const polling = session.lease !== null && new Date(session.lease.expiresAt).getTime() > now;

  return { delivery, polling };
};

/**
 * `delivery` and `polling` are independent, not ranked: a lease can be held
 * during any delivery state, most usefully during `waiting`, so this maps the
 * pair to one label rather than picking a single "most urgent" state.
 * @param {ActivityState} state
 * @returns {string}
 */
export const activityLabel = (state) => {
  if (state.delivery === 'waiting') return state.polling ? 'agent listening' : 'waiting for agent';
  if (state.delivery === 'working') return state.polling ? 'agent working' : 'agent has it';
  return state.polling ? 'agent connected' : '';
};
