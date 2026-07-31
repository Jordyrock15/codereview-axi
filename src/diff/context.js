import { readWorkingFile } from './git.js';

/**
 * @param {string} repo
 * @param {string} relPath
 * @returns {Promise<string[]>}
 */
const fileLines = async (repo, relPath) => {
  const contents = await readWorkingFile(repo, relPath);
  if (contents === null) return [];
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/**
 * Reads an inclusive, 1-indexed line range from the working tree.
 * @param {string} repo
 * @param {string} relPath
 * @param {number} from
 * @param {number} to
 * @returns {Promise<{from: number, to: number, lines: string[]}>}
 */
export const expandContext = async (repo, relPath, from, to) => {
  const lines = await fileLines(repo, relPath);
  if (lines.length === 0) return { from, to, lines: [] };

  const start = Math.max(1, Math.min(from, lines.length));
  const end = Math.max(start, Math.min(to, lines.length));
  return { from: start, to: end, lines: lines.slice(start - 1, end) };
};

/**
 * Reads the fixed window either side of a comment's anchor.
 * @param {string} repo
 * @param {string} relPath
 * @param {number} startLine
 * @param {number} endLine
 * @param {number} radius
 * @returns {Promise<{before: string[], after: string[]}>}
 */
export const commentContext = async (repo, relPath, startLine, endLine, radius) => {
  const lines = await fileLines(repo, relPath);
  const before = lines.slice(Math.max(0, startLine - 1 - radius), Math.max(0, startLine - 1));
  const after = lines.slice(endLine, endLine + radius);
  return { before, after };
};
