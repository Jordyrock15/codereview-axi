/**
 * @typedef {import('../types.js').Session} Session
 * @typedef {import('../types.js').Snapshot} Snapshot
 * @typedef {import('../types.js').SnapshotFile} SnapshotFile
 * @typedef {import('../types.js').Comment} Comment
 */

const ANCHORABLE = ['open', 'reopened'];

/**
 * Flattens a file's hunks into a line-number keyed view of one side.
 * @param {SnapshotFile} file
 * @param {'old'|'new'} side
 * @returns {Map<number, string>}
 */
const sideLines = (file, side) => {
  /** @type {Map<number, string>} */
  const map = new Map();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const number = side === 'old' ? line.oldLine : line.newLine;
      if (number !== null) map.set(number, line.text);
    }
  }
  return map;
};

/**
 * Finds the start line whose following lines equal the quote, nearest to where
 * the comment used to sit.
 * @param {Map<number, string>} lines
 * @param {string[]} quote
 * @param {number} near
 * @returns {number|null}
 */
const locate = (lines, quote, near) => {
  /** @type {number[]} */
  const candidates = [];
  for (const start of lines.keys()) {
    const matches = quote.every((text, offset) => lines.get(start + offset) === text);
    if (matches) candidates.push(start);
  }
  if (candidates.length === 0) return null;

  return candidates.reduce((best, start) => (
    Math.abs(start - near) < Math.abs(best - near) ? start : best
  ));
};

/**
 * Re-anchors comments against a fresh snapshot. Answered and resolved threads
 * are skipped: their quoted code was supposed to change.
 * @param {Session} session
 * @param {Snapshot} snapshot
 * @returns {{relocated: number[], stale: number[]}}
 */
export const reanchor = (session, snapshot) => {
  /** @type {number[]} */
  const relocated = [];
  /** @type {number[]} */
  const stale = [];

  for (const comment of session.comments) {
    if (comment.scope !== 'line') continue;
    if (!ANCHORABLE.includes(comment.status)) continue;
    if (comment.startLine === null || comment.endLine === null) continue;

    const file = snapshot.files.find((f) => f.path === comment.file);
    if (!file) {
      comment.status = 'stale';
      stale.push(comment.id);
      continue;
    }

    const quote = comment.quote.split('\n');
    const lines = sideLines(file, comment.side ?? 'new');
    const found = locate(lines, quote, comment.startLine);

    if (found === null) {
      comment.status = 'stale';
      stale.push(comment.id);
      continue;
    }

    if (found !== comment.startLine) {
      comment.startLine = found;
      comment.endLine = found + quote.length - 1;
      relocated.push(comment.id);
    }
  }

  return { relocated, stale };
};
