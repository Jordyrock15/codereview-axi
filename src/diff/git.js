import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, realpath } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
const git = async (cwd, args) => {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
};

/**
 * @param {string} cwd
 * @returns {Promise<string|null>} Absolute worktree root, or null when cwd is not in a repo.
 */
export const toplevel = async (cwd) => {
  try {
    await access(cwd);
  } catch {
    throw new Error(`no such directory: ${cwd}`);
  }

  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch (/** @type {any} */ err) {
    // cwd exists, so a spawn ENOENT can only be git itself missing:
    // the error carries nothing that separates the two causes.
    if (err.code === 'ENOENT') throw new Error('git not found on PATH');
    return null;
  }
};

/**
 * @param {string} repo
 * @returns {Promise<string>} The branch name, or 'detached HEAD' when there is none.
 */
export const currentBranch = async (repo) => {
  const out = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  // git never lets a real branch be named HEAD, so this literal means detached.
  return out === 'HEAD' ? 'detached HEAD' : out;
};

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M', '--find-renames', '-U3'];

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * @param {string} message
 * @param {'missing-ref'|'unrelated-history'|'invalid-ref'} reason
 * @returns {Error}
 */
const baseFailure = (message, reason) => {
  const err = new Error(message);
  // A caller further up (the server route) needs to tell these two apart to
  // give each its own status and hint, without re-parsing git's prose.
  /** @type {any} */ (err).crReason = reason;
  return err;
};

/**
 * Conservative syntax check for a ref that did not originate with the local,
 * trusted user, principally a PR's base branch as reported by `gh`. This does
 * not stop a ref built to look like a shell command (git ref names may
 * contain `;`, `|`, `` ` ``: only quoting at the point of display does that);
 * what it does stop is a ref shaped like an option, for example `--help`,
 * which would otherwise be read by git itself as a flag rather than a name.
 * A revision expression such as `HEAD~3` is deliberately allowed: it is a
 * legitimate base, and `merge-base` reports its own error for anything that
 * does not resolve.
 * @param {string} ref
 * @returns {boolean}
 */
export const isOptionShaped = (ref) => ref.startsWith('-');

/**
 * Where the branch diverged from its base. That, not the base tip, is the
 * review surface: diffing the tip would show independent work on the base
 * branch reversed.
 * @param {string} repo
 * @param {string} base
 * @returns {Promise<string>}
 */
export const mergeBase = async (repo, base) => {
  if (isOptionShaped(base)) {
    throw baseFailure(`${base} is not a valid ref name`, 'invalid-ref');
  }

  let out;
  try {
    // `--` closes option parsing, so a ref shaped like a flag (`--help`)
    // cannot be read as one even if `isValidRef` above were ever bypassed.
    out = await git(repo, ['merge-base', '--', base, 'HEAD']);
  } catch (/** @type {any} */ err) {
    // git exits 128 for a bad revision or ref; anything else (unrelated
    // histories exit 1) is the other case. Either way, keep git's own detail.
    if (err.code === 128) {
      const detail = typeof err.stderr === 'string' && err.stderr.trim() !== ''
        ? err.stderr.trim().split('\n')[0]
        : err.message;
      throw baseFailure(`could not resolve ${base}: ${detail}`, 'missing-ref');
    }
    throw baseFailure(`no common history between ${base} and HEAD`, 'unrelated-history');
  }
  const sha = out.trim();
  // Some git versions resolve empty on unrelated histories rather than rejecting.
  if (sha === '') throw baseFailure(`no common history between ${base} and HEAD`, 'unrelated-history');
  return sha;
};

// core.quotePath defaults on, so a non-ASCII filename would otherwise arrive
// C-escaped in the header line and fail the plain path regex in parse.js.
const QUOTEPATH_OFF = ['-c', 'core.quotePath=false'];

/**
 * HEAD (or a base ref's merge base) against the working tree: staged and
 * unstaged changes in one diff.
 * @param {string} repo
 * @param {string} [base]
 * @returns {Promise<string>}
 */
export const diffWorking = async (repo, base) => {
  if (base !== undefined) return git(repo, [...QUOTEPATH_OFF, 'diff', await mergeBase(repo, base), ...DIFF_FLAGS]);
  try {
    await git(repo, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    // An unborn HEAD has nothing to diff against, so use the empty tree.
    return git(repo, [...QUOTEPATH_OFF, 'diff', EMPTY_TREE, ...DIFF_FLAGS]);
  }
  return git(repo, [...QUOTEPATH_OFF, 'diff', 'HEAD', ...DIFF_FLAGS]);
};

/** @param {string} repo @returns {Promise<string[]>} */
export const untrackedPaths = async (repo) => {
  const out = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter((entry) => entry.length > 0);
};

/**
 * A branch under review can contain a symlink out of the tree, and git reports
 * it as an ordinary path, so confinement has to happen at the read.
 * @param {string} repo
 * @param {string} relPath
 * @returns {Promise<string|null>} The resolved path, or null when it escapes.
 */
const resolveInside = async (repo, relPath) => {
  try {
    const root = await realpath(repo);
    const real = await realpath(path.join(root, relPath));
    return real === root || real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null;
  }
};

/**
 * @param {string} repo
 * @param {string} relPath
 * @returns {Promise<string|null>} Contents, or null when the file is gone or escapes the repo.
 */
export const readWorkingFile = async (repo, relPath) => {
  const real = await resolveInside(repo, relPath);
  if (real === null) return null;
  try {
    return await readFile(real, 'utf8');
  } catch {
    return null;
  }
};

/**
 * @param {string} repo
 * @param {string} relPath
 * @returns {Promise<boolean>} True when the file contains a NUL byte in its first 8KB.
 */
export const isBinaryPath = async (repo, relPath) => {
  const real = await resolveInside(repo, relPath);
  if (real === null) return false;
  try {
    const buf = await readFile(real);
    return buf.subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
};
