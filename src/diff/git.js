import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
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
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
};

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M', '--find-renames', '-U3'];

/** @param {string} repo @returns {Promise<string>} */
export const diffUnstaged = (repo) => git(repo, ['diff', ...DIFF_FLAGS]);

/** @param {string} repo @returns {Promise<string>} */
export const diffStaged = (repo) => git(repo, ['diff', '--staged', ...DIFF_FLAGS]);

/** @param {string} repo @returns {Promise<string[]>} */
export const untrackedPaths = async (repo) => {
  const out = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter((entry) => entry.length > 0);
};

/**
 * @param {string} repo
 * @param {string} relPath
 * @returns {Promise<string|null>} Contents, or null when the file is gone.
 */
export const readWorkingFile = async (repo, relPath) => {
  try {
    return await readFile(path.join(repo, relPath), 'utf8');
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
  try {
    const buf = await readFile(path.join(repo, relPath));
    return buf.subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
};
