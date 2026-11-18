import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { loadTypeScript } from '../../src/graph/typescript.js';
import { makeTree } from './tree.js';

const require = createRequire(import.meta.url);
const ownTypeScriptDir = dirname(require.resolve('typescript/package.json'));
/** @type {string} */
const ownVersion = require('typescript').version;

/**
 * @param {Record<string, string>} files
 * @param {import('../../src/graph/typescript.js').ILoadTypeScriptOptions} [options]
 * @returns {Promise<import('../../src/graph/typescript.js').ITypeScriptPick>}
 */
const pickFor = async (files, options) => {
  const tree = await makeTree(files);
  try {
    return loadTypeScript(tree.dir, options);
  } finally {
    await tree.cleanup();
  }
};

/**
 * @param {string} version
 * @returns {string}
 */
const packageWith = (version) => JSON.stringify({ name: 'typescript', version, main: 'index.js' });

test('repo typescript never runs', async () => {
  const pick = await pickFor({
    'node_modules/typescript/package.json': packageWith('5.0.0-fake'),
    'node_modules/typescript/index.js': `globalThis.__crRepoTypescriptRan = true; module.exports = require(${JSON.stringify(ownTypeScriptDir)});`,
  });
  assert.equal(/** @type {any} */ (globalThis).__crRepoTypescriptRan, undefined);
  assert.equal(pick.from, 'bundled');
  assert.equal(pick.version, ownVersion);
  assert.equal(pick.repoVersion, '5.0.0-fake');
  assert.equal(pick.message, `Import links from the TypeScript ${ownVersion} in codereview-axi. This repo has TypeScript 5.0.0-fake.`);
  assert.equal(typeof pick.ts.preProcessFile, 'function');
});

test('no repo typescript', async () => {
  const pick = await pickFor({});
  assert.equal(pick.from, 'bundled');
  assert.equal(pick.repoVersion, null);
  assert.equal(pick.message, `Import links from the TypeScript ${ownVersion} in codereview-axi. This repo has no TypeScript.`);
});

test('typescript 7', async () => {
  const pick = await pickFor({ 'node_modules/typescript/package.json': packageWith('7.0.2') });
  assert.equal(pick.repoVersion, '7.0.2');
  assert.ok(pick.message.endsWith('This repo has TypeScript 7.0.2.'), pick.message);
});

test('bad package.json', async () => {
  for (const text of ['{ "version": ', '{ "version": 7 }']) {
    const pick = await pickFor({ 'node_modules/typescript/package.json': text });
    assert.equal(pick.repoVersion, null);
    assert.ok(pick.message.endsWith('This repo has no TypeScript.'), pick.message);
  }
});

test('bundled does not load', async () => {
  const pick = await pickFor({}, { loadBundled: () => { throw new Error('gone'); } });
  assert.equal(pick.ts, null);
  assert.equal(pick.from, 'none');
  assert.equal(pick.version, null);
  assert.equal(pick.message, 'No import links: the TypeScript in codereview-axi did not load.');
});
