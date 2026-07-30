import { StateError } from './errors.js';

/**
 * @typedef {import('../types.js').Comment} Comment
 * @typedef {import('../types.js').Session} Session
 */

const VERDICTS = ['fix', 'explain', 'ignore'];
const REPLY_STATUSES = ['fixed', 'explained', 'skipped'];
const SENDABLE = ['open', 'reopened'];

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
    agentReply: null,
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
    if (!['resolved', 'reopened'].includes(patch.status)) {
      throw new StateError(400, 'status may only be set to resolved or reopened');
    }
    if (!['answered', 'resolved', 'reopened'].includes(comment.status)) {
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
    // Clear the stamp: at-most-once is per round, so a reopened comment must be
    // deliverable again or the human's disagreement never reaches the agent.
    comment.deliveredAt = null;
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
  comment.agentReply = {
    status: /** @type {'fixed'|'explained'|'skipped'} */ (reply.status),
    body: String(reply.body ?? ''),
    at,
  };
  comment.status = 'answered';
  comment.updatedAt = at;
  session.updatedAt = at;
  return comment;
};
