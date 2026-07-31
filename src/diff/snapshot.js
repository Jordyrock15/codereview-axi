import { parseUnifiedDiff } from './parse.js';
import { diffWorking, untrackedPaths, readWorkingFile, isBinaryPath } from './git.js';

/**
 * @typedef {import('../types.js').Snapshot} Snapshot
 * @typedef {import('../types.js').SnapshotFile} SnapshotFile
 */

export const LARGE_FILE_LINES = 1500;

// A file can clear the line-count guard above and still be pathological: one
// 8MB line is `added: 1`. Highlighting amplifies text into HTML at roughly
// 17x for quote-heavy content, so a byte ceiling well under what the browser
// can survive catches the case line count cannot.
export const LARGE_FILE_BYTES = 200_000;

/**
 * Total size of a file's rendered text, hunks and untracked content alike:
 * the byte cost the browser pays is the same regardless of which produced it.
 * @param {{hunks: {lines: {text: string}[]}[]}} file
 * @returns {number}
 */
const totalBytes = (file) => file.hunks.reduce((sum, hunk) => (
  sum + hunk.lines.reduce((s, line) => s + Buffer.byteLength(line.text), 0)
), 0);

/**
 * A path collision must never reach a caller silently: every lookup
 * downstream (`find`, `forced`, `draftKey`, `requireDiffFile`) assumes one
 * entry per path, and a match on the wrong one hides whichever file sorted
 * second. Every entry sharing a path beyond the first is renamed with a
 * disambiguating suffix and every one of them is tagged, so the collision is
 * visible rather than one silently shadowing another.
 * @param {SnapshotFile[]} files
 * @returns {void}
 */
export const tagDuplicatePaths = (files) => {
  /** @type {Map<string, number>} */
  const total = new Map();
  for (const file of files) total.set(file.path, (total.get(file.path) ?? 0) + 1);

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const file of files) {
    const original = file.path;
    if ((total.get(original) ?? 0) <= 1) continue;

    const n = (seen.get(original) ?? 0) + 1;
    seen.set(original, n);
    file.tags.push('duplicate-path');
    if (n > 1) file.path = `${original} (duplicate ${n})`;
  }
};

const GENERATED = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock)$/,
  /(^|\/)(dist|build|coverage|vendor|node_modules)\//,
  /\.min\.(js|css)$/,
  /\.snap$/,
  /\.generated\.[^/]+$/,
];

/** @param {string} path @returns {boolean} */
const isGenerated = (path) => GENERATED.some((re) => re.test(path));

/**
 * @param {string} repo
 * @param {string} relPath
 * @returns {Promise<SnapshotFile>}
 */
const untrackedFile = async (repo, relPath) => {
  if (await isBinaryPath(repo, relPath)) {
    return {
      path: relPath, oldPath: null, status: 'added', binary: true,
      added: 0, removed: 0, hunks: [], tags: ['untracked', 'binary'],
    };
  }

  const contents = (await readWorkingFile(repo, relPath)) ?? '';
  const rawLines = contents.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();

  const lines = rawLines.map((text, i) => ({
    kind: /** @type {'add'} */ ('add'), text, oldLine: null, newLine: i + 1,
  }));

  const file = {
    path: relPath,
    oldPath: null,
    status: /** @type {'added'} */ ('added'),
    binary: false,
    added: lines.length,
    removed: 0,
    hunks: lines.length === 0 ? [] : [{
      oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, header: '', lines,
    }],
    tags: /** @type {string[]} */ (['untracked']),
  };
  if (file.added > LARGE_FILE_LINES || totalBytes(file) > LARGE_FILE_BYTES) file.tags.push('large');
  return file;
};

/**
 * Computes the full working diff for a worktree.
 * @param {string} repo
 * @param {string} [base]
 * @returns {Promise<Snapshot>}
 */
export const buildSnapshot = async (repo, base) => {
  const [working, untracked] = await Promise.all([
    diffWorking(repo, base),
    untrackedPaths(repo),
  ]);

  /** @type {SnapshotFile[]} */
  const files = parseUnifiedDiff(working).map((file) => ({
    ...file,
    tags: [
      ...(file.tags ?? []),
      ...(file.binary ? ['binary'] : []),
      ...(isGenerated(file.path) ? ['generated'] : []),
      ...(file.added + file.removed > LARGE_FILE_LINES || totalBytes(file) > LARGE_FILE_BYTES ? ['large'] : []),
    ],
  }));

  for (const relPath of untracked) {
    const file = await untrackedFile(repo, relPath);
    if (isGenerated(relPath)) file.tags.push('generated');
    files.push(file);
  }

  tagDuplicatePaths(files);

  files.sort((a, b) => {
    const gen = Number(a.tags.includes('generated')) - Number(b.tags.includes('generated'));
    return gen !== 0 ? gen : a.path.localeCompare(b.path);
  });

  return {
    files,
    totals: {
      files: files.length,
      added: files.reduce((sum, f) => sum + f.added, 0),
      removed: files.reduce((sum, f) => sum + f.removed, 0),
    },
  };
};
