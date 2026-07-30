import { parseUnifiedDiff } from './parse.js';
import { diffStaged, diffUnstaged, untrackedPaths, readWorkingFile, isBinaryPath } from './git.js';

/**
 * @typedef {import('../types.js').Snapshot} Snapshot
 * @typedef {import('../types.js').SnapshotFile} SnapshotFile
 * @typedef {import('../types.js').DiffFile} DiffFile
 */

export const LARGE_FILE_LINES = 1500;

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
 * Later files win on hunks, but line counts are taken from the union so a
 * partly staged file reports the whole change rather than half of it.
 * @param {DiffFile} base
 * @param {DiffFile} extra
 * @returns {DiffFile}
 */
const mergeFile = (base, extra) => ({
  ...base,
  status: base.status === 'modified' ? extra.status : base.status,
  oldPath: base.oldPath ?? extra.oldPath,
  binary: base.binary || extra.binary,
  added: base.added + extra.added,
  removed: base.removed + extra.removed,
  hunks: [...base.hunks, ...extra.hunks],
});

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

  return {
    path: relPath,
    oldPath: null,
    status: 'added',
    binary: false,
    added: lines.length,
    removed: 0,
    hunks: lines.length === 0 ? [] : [{
      oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, header: '', lines,
    }],
    tags: ['untracked'],
  };
};

/**
 * Computes the full working diff for a worktree.
 * @param {string} repo
 * @returns {Promise<Snapshot>}
 */
export const buildSnapshot = async (repo) => {
  const [staged, unstaged, untracked] = await Promise.all([
    diffStaged(repo),
    diffUnstaged(repo),
    untrackedPaths(repo),
  ]);

  /** @type {Map<string, DiffFile>} */
  const byPath = new Map();
  for (const file of [...parseUnifiedDiff(staged), ...parseUnifiedDiff(unstaged)]) {
    const existing = byPath.get(file.path);
    byPath.set(file.path, existing ? mergeFile(existing, file) : file);
  }

  /** @type {SnapshotFile[]} */
  const files = [...byPath.values()].map((file) => ({
    ...file,
    tags: [
      ...(file.binary ? ['binary'] : []),
      ...(isGenerated(file.path) ? ['generated'] : []),
      ...(file.added + file.removed > LARGE_FILE_LINES ? ['large'] : []),
    ],
  }));

  for (const relPath of untracked) {
    const file = await untrackedFile(repo, relPath);
    if (isGenerated(relPath)) file.tags.push('generated');
    if (file.added > LARGE_FILE_LINES) file.tags.push('large');
    files.push(file);
  }

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
