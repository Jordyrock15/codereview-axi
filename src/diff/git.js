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

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M', '--find-renames', '-U3'];

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * HEAD against the working tree: staged and unstaged changes in one diff.
 * @param {string} repo
 * @returns {Promise<string>}
 */
export const diffWorking = async (repo) => {
  try {
    await git(repo, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    // An unborn HEAD has nothing to diff against, so use the empty tree.
    return git(repo, ['diff', EMPTY_TREE, ...DIFF_FLAGS]);
  }
  return git(repo, ['diff', 'HEAD', ...DIFF_FLAGS]);
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
