/**
 * The human's in-progress line selection.
 * @interface Pick
 * @typedef {Object} Pick
 * @property {string|null} file — Path the selection sits in, null when nothing is picked.
 * @property {'old'|'new'} side — Which gutter the selection was made in.
 * @property {number|null} start — First picked line, null when nothing is picked.
 * @property {number|null} end — Last picked line, null when nothing is picked.
 * @property {string|null} hunk — Hunk the selection belongs to, null when nothing is picked.
 */

/**
 * One gutter click, as the selection rules need it.
 * @interface PickClick
 * @typedef {Object} PickClick
 * @property {string} file — Path of the file the row belongs to.
 * @property {'old'|'new'} side — Which gutter took the click.
 * @property {number} line — Line number under the click.
 * @property {string|null} hunk — Hunk the clicked row belongs to.
 * @property {boolean} shiftKey — Whether shift was held.
 */

/**
 * The selection after one gutter click, with what the caller must show.
 * @interface PickOutcome
 * @typedef {Object} PickOutcome
 * @property {Pick} pick — The selection after the click.
 * @property {boolean} shiftExtend — True when the click extended the range instead of starting a new one.
 * @property {boolean} rejected — True when a shift-click could not extend, so the caller must say why.
 */

/**
 * The side must match: the old and new gutters are adjacent columns, so
 * extending across them would build a quote for code the human never chose.
 * The hunk must match as well: crossing into another hunk starts a fresh
 * selection rather than silently splicing out the unchanged gap between them.
 *
 * A shift-click only counts as a rejection if there was a selection to extend
 * in the first place: a plain click, or the very first shift-click with
 * nothing picked yet, is not a rejection and must stay silent.
 * @param {Pick} pick
 * @param {PickClick} click
 * @returns {PickOutcome}
 */
export const nextPick = (pick, click) => {
  const sameSelection = pick.start !== null && pick.file === click.file;
  const shiftExtend = click.shiftKey && sameSelection && click.side === pick.side && click.hunk === pick.hunk;

  if (shiftExtend) {
    return { pick: { ...pick, end: click.line }, shiftExtend: true, rejected: false };
  }

  return {
    pick: { file: click.file, side: click.side, start: click.line, end: click.line, hunk: click.hunk },
    shiftExtend: false,
    rejected: click.shiftKey && sameSelection,
  };
};

/**
 * @param {Pick} pick
 * @returns {{from: number, to: number}}
 */
export const pickRange = (pick) => {
  const start = pick.start ?? 0;
  const end = pick.end ?? start;
  return { from: Math.min(start, end), to: Math.max(start, end) };
};

/**
 * @param {number} line
 * @param {'old'|'new'} side
 * @param {Pick} pick
 * @returns {boolean}
 */
export const inPickRange = (line, side, pick) => {
  if (pick.start === null || side !== pick.side) return false;
  const { from, to } = pickRange(pick);
  return line >= from && line <= to;
};

/**
 * In-progress composer text survives a re-render only if it is kept outside
 * the DOM the render wipes. Keyed by file, side and the range's start line,
 * not the end: a shift-extend changes the end without rebuilding the
 * composer, so keying on the end too would silently fork a single in-progress
 * draft into two map entries, the older of which `clearPick` would never
 * reach. A different pick (different file, side or start line) still gets its
 * own entry and never inherits someone else's draft.
 * @param {Pick} pick
 * @returns {string}
 */
export const draftKey = (pick) => `${pick.file}::${pick.side}::${pick.start}`;
