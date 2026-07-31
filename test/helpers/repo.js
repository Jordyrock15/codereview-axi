import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Creates a throwaway git repo with one commit, for tests.
 * @param {Record<string, string>} files: path to contents, committed as the base.
 */
export const makeRepo = async (files = {}) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-repo-'));
  /** @param {string[]} args */
  const run = async (args) => (await exec('git', args, { cwd: dir })).stdout;

  await run(['init', '--initial-branch=main']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Test']);
  await run(['config', 'commit.gpgsign', 'false']);

  /**
   * @param {string} rel
   * @param {string} contents
   */
  const write = async (rel, contents) => {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  };

  for (const [rel, contents] of Object.entries(files)) await write(rel, contents);
  if (Object.keys(files).length > 0) {
    await run(['add', '-A']);
    await run(['commit', '-m', 'base']);
  }

  return { dir, write, run, cleanup: () => rm(dir, { recursive: true, force: true }) };
};
