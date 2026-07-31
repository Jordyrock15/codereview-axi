import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
const defaultRun = async (args, cwd) => (await exec('gh', args, { cwd, maxBuffer: 1024 * 1024 })).stdout;

/**
 * @param {number|string|boolean} number
 * @returns {number}
 */
export const parsePrNumber = (number) => {
  const n = Number(number);
  if (typeof number === 'boolean' || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--pr needs a positive whole number, got ${JSON.stringify(number)}`);
  }
  return n;
};

/**
 * Resolves a pull request's base and head branch names via `gh`, so `--pr`
 * can behave as `--base <baseRefName>` would.
 * @param {number|string} number
 * @param {{run?: (args: string[], cwd?: string) => Promise<string>, cwd?: string}} [options]
 * @returns {Promise<{base: string, head: string}>}
 */
export const resolvePr = async (number, { run = defaultRun, cwd } = {}) => {
  const n = parsePrNumber(number);

  let stdout;
  try {
    stdout = await run(['pr', 'view', String(n), '--json', 'baseRefName,headRefName'], cwd);
  } catch (/** @type {any} */ err) {
    if (err?.code === 'ENOENT') {
      throw new Error('gh not found on PATH, install it or use --base instead');
    }
    if (err?.code === 4) {
      throw new Error('gh is not authenticated. Run: gh auth login, or use --base instead');
    }
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const detail = stderr !== '' ? stderr.split('\n')[0].trim() : (err?.message ?? String(err));
    throw new Error(`gh could not resolve PR ${n}: ${detail}. Use --base instead`);
  }

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not read gh's response for PR ${n}`);
  }

  if (typeof parsed?.baseRefName !== 'string' || typeof parsed?.headRefName !== 'string') {
    throw new Error(`gh's response for PR ${n} is missing baseRefName/headRefName`);
  }

  return { base: parsed.baseRefName, head: parsed.headRefName };
};
