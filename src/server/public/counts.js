/**
 * @typedef {import('../../types.js').Comment} Comment
 */

/**
 * Everything the header's counters and the two Send buttons render.
 * @interface CountsView
 * @typedef {Object} CountsView
 * @property {number} unsent — Comments still `open`, the number Send offers to send.
 * @property {number} answered — Comments the agent has replied to.
 * @property {number} stale — Comments whose anchor no longer matches the diff.
 * @property {number} resolved — Threads the human has closed.
 * @property {number} pending — Comments the agent holds and owes a reply on.
 * @property {string} staleLabel — The stale count as text, empty when nothing is stale.
 * @property {string} sendLabel — The text both Send buttons carry.
 * @property {boolean} sendDisabled — Whether both Send buttons are disabled.
 * @property {string} sendTitle — Why Send is blocked, empty when it is not.
 */

/**
 * One round at a time. A batch sent while the agent still owes replies on the
 * last one arrives mid-edit and gets answered against code that has already
 * moved, and it was how sixteen comments ended up in flight at once with no
 * way to tell which round they belonged to. Queue as much as you like; the
 * send waits.
 * @param {Comment[]} comments
 * @returns {CountsView}
 */
export const countsView = (comments) => {
  /**
   * @param {Comment['status']} status
   * @returns {number}
   */
  const count = (status) => comments.filter((c) => c.status === status).length;

  const unsent = count('open');
  const stale = count('stale');
  const awaitingAgent = count('sent');
  const blocked = awaitingAgent > 0;

  return {
    unsent,
    answered: count('answered'),
    stale,
    resolved: count('resolved'),
    pending: awaitingAgent,
    staleLabel: stale === 0 ? '' : `${stale} stale`,
    sendLabel: unsent === 0 ? 'Send' : `Send ${unsent}`,
    sendDisabled: unsent === 0 || blocked,
    sendTitle: blocked
      ? `The agent still owes ${awaitingAgent === 1 ? 'a reply' : `${awaitingAgent} replies`}. Your drafts stay queued until it has answered.`
      : '',
  };
};
