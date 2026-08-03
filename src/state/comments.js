import { StateError } from './errors.js';

/**
 * @typedef {import('../types.js').Comment} Comment
 * @typedef {import('../types.js').Message} Message
 * @typedef {import('../types.js').Session} Session
 */

const VERDICTS = ['fix', 'explain', 'ignore'];
const REPLY_STATUSES = ['fixed', 'explained', 'skipped'];
const SENDABLE = ['open'];

/**
 * @param {Session} session
 * @param {number} id
 * @returns {Comment}
 */
const find = (session, id) => {
  const comment = session.comments.find((c) => c.id === id);
  if (!comment) throw new StateError(404, `no comment with id ${id}`);
  return comment;
};

/**
 * @param {Session} session
 * @param {Partial<Comment>} input
 * @param {number} now
 * @returns {Comment}
 */
export const addComment = (session, input, now) => {
  const body = String(input.body ?? '').trim();
  if (body === '') throw new StateError(400, 'body is required');

  const verdict = input.verdict ?? 'fix';
  if (!VERDICTS.includes(verdict)) throw new StateError(400, `verdict must be one of ${VERDICTS.join(', ')}`);

  const scope = input.scope ?? 'line';
  const at = new Date(now).toISOString();
  const positioned = scope === 'line';

  /** @type {Comment} */
  const comment = {
    id: session.comments.reduce((max, c) => Math.max(max, c.id), 0) + 1,
    scope,
    file: scope === 'session' ? null : (input.file ?? null),
    side: positioned ? (input.side ?? 'new') : null,
    startLine: positioned ? (input.startLine ?? null) : null,
    endLine: positioned ? (input.endLine ?? input.startLine ?? null) : null,
    quote: positioned ? String(input.quote ?? '') : '',
    body,
    verdict,
    status: 'open',
    replies: [],
    deliveredAt: null,
    createdAt: at,
    updatedAt: at,
  };

  session.comments.push(comment);
  session.updatedAt = at;
  return comment;
};

/**
 * @param {Session} session
 * @param {number} id
 * @param {{body?: string, verdict?: string, status?: string}} patch
 * @param {number} now
 * @returns {Comment}
 */
export const patchComment = (session, id, patch, now) => {
  const comment = find(session, id);
  const at = new Date(now).toISOString();

  // An edit is new information, so it must be deliverable again even if this
  // comment was already handed to an agent in an earlier round.
  if (patch.body !== undefined || patch.verdict !== undefined) comment.deliveredAt = null;

  if (patch.body !== undefined) {
    const body = String(patch.body).trim();
    if (body === '') throw new StateError(400, 'body cannot be empty');
    comment.body = body;
  }

  if (patch.verdict !== undefined) {
    if (!VERDICTS.includes(patch.verdict)) throw new StateError(400, `verdict must be one of ${VERDICTS.join(', ')}`);
    comment.verdict = /** @type {Comment['verdict']} */ (patch.verdict);
  }

  if (patch.status !== undefined) {
    if (patch.status !== 'resolved') throw new StateError(400, 'status may only be set to resolved');

    const allowedFrom = ['answered', 'resolved'];
    if (!allowedFrom.includes(comment.status)) {
      if (comment.status === 'stale') {
        throw new StateError(409, `comment ${id} is stale, its code no longer exists`);
      }
      throw new StateError(409, `comment ${id} is ${comment.status}, the agent has not answered it`);
    }
    comment.status = /** @type {Comment['status']} */ (patch.status);
  }

  comment.updatedAt = at;
  session.updatedAt = at;
  return comment;
};

/**
 * @param {Session} session
 * @returns {Comment[]}
 */
export const openComments = (session) => session.comments.filter((c) => SENDABLE.includes(c.status));

/**
 * True if `comment` carries a human message `cr wait` has not yet drained:
 * the opening one, or any follow-up. Delivery is per-message now, so a
 * comment already delivered once can still owe a later follow-up.
 * @param {Comment} comment
 * @returns {boolean}
 */
export const hasUndeliveredHuman = (comment) => comment.status === 'sent' && (
  comment.deliveredAt === null || comment.replies.some((m) => m.role === 'human' && m.deliveredAt === null)
);

/**
 * Stamps every currently-undelivered human message on `comment` as delivered,
 * in one poll's round, so at-most-once holds per message rather than per comment.
 * @param {Comment} comment
 * @param {string} at
 * @returns {void}
 */
export const markDelivered = (comment, at) => {
  if (comment.deliveredAt === null) comment.deliveredAt = at;
  for (const message of comment.replies) {
    if (message.role === 'human' && message.deliveredAt === null) message.deliveredAt = at;
  }
};

/**
 * @param {Session} session
 * @returns {number}
 */
export const unsentCount = (session) => openComments(session).length;

/**
 * Hands the open comments to the agent. A Send with nothing open is a no-op.
 * @param {Session} session
 * @param {number} now
 * @returns {Comment[]}
 */
export const markSent = (session, now) => {
  const sending = openComments(session);
  if (sending.length === 0) return [];

  const at = new Date(now).toISOString();
  for (const comment of sending) {
    comment.status = 'sent';
    comment.updatedAt = at;
  }
  session.updatedAt = at;
  return sending;
};

/**
 * @param {Session} session
 * @param {number} id
 * @param {{status: string, body: string}} reply
 * @param {number} now
 * @returns {Comment}
 */
export const applyReply = (session, id, reply, now) => {
  const comment = find(session, id);
  if (!REPLY_STATUSES.includes(reply.status)) {
    throw new StateError(400, `status must be one of ${REPLY_STATUSES.join(', ')}`);
  }
  if (comment.status !== 'sent') {
    throw new StateError(409, `comment ${id} is ${comment.status}, not awaiting a reply`);
  }

  const at = new Date(now).toISOString();
  /** @type {Message} */
  const message = {
    role: 'agent',
    body: String(reply.body ?? ''),
    status: /** @type {'fixed'|'explained'|'skipped'} */ (reply.status),
    at,
    deliveredAt: null,
  };
  comment.replies.push(message);
  comment.status = 'answered';
  comment.updatedAt = at;
  session.updatedAt = at;
  return comment;
};

/**
 * A human follow-up on an answered thread: new text, appended rather than
 * overwriting the opening comment, and re-queued so the human can review it
 * before it reaches the agent. This is what replaces Reopen — Reopen resent
 * the same body, which sent the agent back over ground already covered.
 * @param {Session} session
 * @param {number} id
 * @param {string} body
 * @param {number} now
 * @returns {Comment}
 */
export const addFollowup = (session, id, body, now) => {
  const comment = find(session, id);
  if (comment.status !== 'answered') {
    throw new StateError(409, `comment ${id} is ${comment.status}, a follow-up only makes sense on an answered thread`);
  }

  const trimmed = String(body ?? '').trim();
  if (trimmed === '') throw new StateError(400, 'body cannot be empty');

  const at = new Date(now).toISOString();
  /** @type {Message} */
  const message = {
    role: 'human', body: trimmed, status: null, at, deliveredAt: null,
  };
  comment.replies.push(message);
  comment.status = 'open';
  comment.updatedAt = at;
  session.updatedAt = at;
  return comment;
};

/**
 * What Remove does in the queue panel. A comment that has never been sent has
 * nothing to lose, so it is deleted outright. A comment queued again by a
 * follow-up already carries an answered exchange: deleting it would throw
 * that away for the sake of cancelling one draft, so this only pops the
 * undelivered draft and puts the thread back to answered.
 * @param {Session} session
 * @param {number} id
 * @param {number} now
 * @returns {{removed: true}|{removed: false, comment: Comment}}
 */
export const removeQueued = (session, id, now) => {
  const index = session.comments.findIndex((c) => c.id === id);
  if (index === -1) throw new StateError(404, `no comment with id ${id}`);
  const comment = session.comments[index];
  if (comment.status !== 'open') throw new StateError(409, `comment ${id} is ${comment.status}, not queued`);

  const at = new Date(now).toISOString();
  if (comment.replies.length === 0) {
    session.comments.splice(index, 1);
    session.updatedAt = at;
    return { removed: true };
  }

  comment.replies.pop();
  comment.status = 'answered';
  comment.updatedAt = at;
  session.updatedAt = at;
  return { removed: false, comment };
};
