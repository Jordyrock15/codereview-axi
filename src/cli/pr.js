import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * @param {string[]} args
 * @returns {Promise<string>}
 */
const defaultRun = async (args) => (await exec('gh', args, { maxBuffer: 1024 * 1024 })).stdout;

/**
 * Resolves a pull request's base and head branch names via `gh`, so `--pr`
 * can behave as `--base <baseRefName>` would.
 * @param {number|string} number
 * @param {{run?: (args: string[]) => Promise<string>}} [options]
 * @returns {Promise<{base: string, head: string}>}
 */
export const resolvePr = async (number, { run = defaultRun } = {}) => {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--pr needs a positive whole number, got ${JSON.stringify(number)}`);
  }

  let stdout;
  try {
    stdout = await run(['pr', 'view', String(n), '--json', 'baseRefName,headRefName']);
  } catch (/** @type {any} */ err) {
    if (err?.code === 'ENOENT') {
      throw new Error('gh not found on PATH, install it or use --base instead');
    }
    const detail = typeof err?.stderr === 'string' && err.stderr.trim() !== ''
      ? err.stderr.trim()
      : err?.message ?? String(err);
    throw new Error(`gh could not resolve PR ${n}: ${detail}, or use --base instead`);
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
