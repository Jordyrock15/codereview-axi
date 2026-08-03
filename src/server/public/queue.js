/**
 * @typedef {import('../../types.js').Session} Session
 * @typedef {import('../../types.js').Comment} Comment
 */

const QUEUED = ['open', 'reopened'];

/**
 * @param {Comment} comment
 * @returns {string}
 */
const location = (comment) => {
  if (comment.scope === 'session') return 'session note';
  if (comment.file === null) return '';
  if (comment.scope === 'file' || comment.startLine === null) return comment.file;
  return comment.startLine === comment.endLine
    ? `${comment.file}:${comment.startLine}`
    : `${comment.file}:${comment.startLine}-${comment.endLine}`;
};

/**
 * One row of the queue panel: everything it renders, precomputed, so the
 * panel is a thin map over this rather than reaching into Comment fields itself.
 * @interface QueueEntry
 * @typedef {Object} QueueEntry
 * @property {number} id — The comment's id, used to find it again on click or removal.
 * @property {string|null} file — The file it is anchored to, null for a session-scope note.
 * @property {string} verdict — fix, explain or ignore.
 * @property {string} body — The comment text, unclamped; the panel clamps it visually.
 * @property {string} location — A human-readable file:range label, ready to render.
 */

/**
 * The queue as the human is about to send it: every comment still `open` or
 * `reopened`, in the order they were added.
 * @param {Pick<Session, 'comments'>} session
 * @returns {QueueEntry[]}
 */
export const queueEntries = (session) => session.comments
  .filter((c) => QUEUED.includes(c.status))
  .map((c) => ({
    id: c.id, file: c.file, verdict: c.verdict, body: c.body, location: location(c),
  }));
