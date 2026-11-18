import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Interface representing the TypeScript that the graph builder picked.
 * @interface ITypeScriptPick
 * @typedef {Object} ITypeScriptPick
 * @property {any|null} ts — The TypeScript module of codereview-axi, null when it did not load.
 * @property {'bundled'|'none'} from — Where the TypeScript came from.
 * @property {string|null} version — Version of the picked TypeScript, null for none.
 * @property {string|null} repoVersion — Version of the TypeScript in the reviewed repo, null for none.
 * @property {string} message — One line that says which TypeScript made the import links.
 */

/**
 * Interface representing the options of the TypeScript loader.
 * @interface ILoadTypeScriptOptions
 * @typedef {Object} ILoadTypeScriptOptions
 * @property {(() => any)=} loadBundled — Loads the TypeScript in codereview-axi.
 */

const defaultLoadBundled = () => createRequire(import.meta.url)('typescript');

/**
 * @param {any} ts
 * @returns {boolean}
 */
const hasJsApi = (ts) => Boolean(ts) && typeof ts.preProcessFile === 'function' && typeof ts.resolveModuleName === 'function';

/**
 * @param {string} root
 * @returns {string|null}
 */
const readRepoVersion = (root) => {
  try {
    const version = JSON.parse(readFileSync(join(root, 'node_modules', 'typescript', 'package.json'), 'utf8'))?.version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
};

/**
 * @param {() => any} load
 * @returns {any}
 */
const tryLoad = (load) => {
  try {
    return load();
  } catch {
    return null;
  }
};

/**
 * @param {string} root
 * @param {ILoadTypeScriptOptions} [options]
 * @returns {ITypeScriptPick}
 */
export const loadTypeScript = (root, options = {}) => {
  const repoVersion = readRepoVersion(root);
  const ts = tryLoad(options.loadBundled ?? defaultLoadBundled);
  if (!hasJsApi(ts)) {
    return { ts: null, from: 'none', version: null, repoVersion, message: 'No import links: the TypeScript in codereview-axi did not load.' };
  }
  const version = typeof ts.version === 'string' ? ts.version : 'unknown';
  const repoText = repoVersion ? `This repo has TypeScript ${repoVersion}.` : 'This repo has no TypeScript.';
  return { ts, from: 'bundled', version, repoVersion, message: `Import links from the TypeScript ${version} in codereview-axi. ${repoText}` };
};
