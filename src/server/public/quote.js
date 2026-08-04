/**
 * One diff row, as the quote builder needs it.
 * @interface QuoteRow
 * @typedef {Object} QuoteRow
 * @property {number} line — Line number on the side being quoted, 0 when that side has no number on this row.
 * @property {string} hunk — Which hunk the row belongs to, used to judge contiguity.
 * @property {string} text — The text the human saw on this row.
 */

/**
 * @interface QuoteResult
 * @typedef {Object} QuoteResult
 * @property {string} quote — The chosen rows' text, joined by newlines.
 * @property {boolean} contiguous — Whether every chosen row belongs to one hunk.
 * @property {number} rowCount — How many rows the range matched.
 */

/**
 * The rows are what the human saw and chose. Building the quote from them,
 * rather than from file.hunks, is what makes expanded context and hunk edges
 * correct.
 *
 * Contiguity is judged by hunk membership, not by adjacency within the row
 * list: a deleted line has no new-side number and so is skipped when building
 * a new-side quote, but that skip does not break contiguity, the deleted text
 * is genuinely absent from the new file. What does break it is a range that
 * reaches into a different hunk, since the lines omitted between two hunks
 * are real, unselected lines the quote would otherwise silently drop.
 * @param {QuoteRow[]} rows
 * @param {number} from
 * @param {number} to
 * @returns {QuoteResult}
 */
export const buildQuote = (rows, from, to) => {
  const chosen = rows.filter((r) => Number.isInteger(r.line) && r.line >= from && r.line <= to);
  const contiguous = chosen.length > 0 && chosen.every((r) => r.hunk === chosen[0].hunk);
  return { quote: chosen.map((r) => r.text).join('\n'), contiguous, rowCount: chosen.length };
};
