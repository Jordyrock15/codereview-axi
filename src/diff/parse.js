/**
 * @typedef {import('../types.js').DiffFile} DiffFile
 * @typedef {import('../types.js').Hunk} Hunk
 * @typedef {import('../types.js').DiffLine} DiffLine
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parses git's unified diff output.
 * @param {string} text
 * @returns {DiffFile[]}
 */
export const parseUnifiedDiff = (text) => {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile|null} */
  let file = null;
  /** @type {Hunk|null} */
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = line.slice('diff --git '.length).match(/^a\/(.+) b\/(.+)$/);
      file = {
        path: paths ? paths[2] : '',
        oldPath: null,
        status: 'modified',
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('rename from ')) {
      file.oldPath = line.slice('rename from '.length);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length);
      continue;
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('Binary files ')) {
      file.binary = true;
      continue;
    }

    const match = HUNK.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: newLine,
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        header: match[5] ?? '',
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith('\\')) continue;

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
      file.added += 1;
      continue;
    }
    if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
      file.removed += 1;
      continue;
    }
    if (line.startsWith(' ') || line === '') {
      // A bare empty line inside a hunk is an unchanged blank line, not a terminator.
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files;
};
