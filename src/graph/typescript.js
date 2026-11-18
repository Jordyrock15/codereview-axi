import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Interface representing the TypeScript that the graph builder picked.
 * @interface ITypeScriptPick
 * @typedef {Object} ITypeScriptPick
 * @property {any|null} ts — The TypeScript module, null when none has the JS API.
 * @property {'repo'|'bundled'|'none'} from — Where the TypeScript came from.
 * @property {string|null} version — Version of the picked TypeScript, null for none.
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
 * @param {any} ts
 * @returns {string}
 */
const versionOf = (ts) => (ts && typeof ts.version === 'string' ? ts.version : 'unknown');

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
  const repoTs = tryLoad(() => createRequire(join(root, 'package.json'))('typescript'));
  if (hasJsApi(repoTs)) {
    const version = versionOf(repoTs);
    return { ts: repoTs, from: 'repo', version, message: `Import links from this repo's TypeScript ${version}.` };
  }
  const reason = repoTs ? `this repo's TypeScript ${versionOf(repoTs)} has no JS API.` : 'this repo has no TypeScript.';
  const bundledTs = tryLoad(options.loadBundled ?? defaultLoadBundled);
  if (hasJsApi(bundledTs)) {
    const version = versionOf(bundledTs);
    return { ts: bundledTs, from: 'bundled', version, message: `Import links from the TypeScript ${version} in codereview-axi: ${reason}` };
  }
  return { ts: null, from: 'none', version: null, message: `No import links: ${reason}` };
};
