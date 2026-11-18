import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Interface representing a temporary file tree for a graph test.
 * @interface ITree
 * @typedef {Object} ITree
 * @property {string} dir — Absolute path of the tree root.
 * @property {() => Promise<void>} cleanup — Removes the tree.
 */

/**
 * @param {Record<string, string>} files
 * @returns {Promise<ITree>}
 */
export const makeTree = async (files) => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-graph-'));
  for (const [path, text] of Object.entries(files)) {
    const abs = join(dir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};
