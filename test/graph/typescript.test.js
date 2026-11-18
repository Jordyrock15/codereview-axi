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

const fakePackage = JSON.stringify({ name: 'typescript', version: '5.0.0-fake', main: 'index.js' });
const ts7Package = JSON.stringify({ name: 'typescript', version: '7.0.2', main: 'index.js' });
const ts7Index = "module.exports = { version: '7.0.2', versionMajorMinor: '7.0' };";
const noFallback = () => { throw new Error('gone'); };

test('repo typescript with the JS API wins', async () => {
  const tree = await makeTree({
    'node_modules/typescript/package.json': fakePackage,
    'node_modules/typescript/index.js': `module.exports = { ...require(${JSON.stringify(ownTypeScriptDir)}), version: '5.0.0-fake' };`,
  });
  try {
    const pick = loadTypeScript(tree.dir);
    assert.equal(pick.from, 'repo');
    assert.equal(pick.version, '5.0.0-fake');
    assert.equal(pick.message, "Import links from this repo's TypeScript 5.0.0-fake.");
    assert.equal(typeof pick.ts.preProcessFile, 'function');
  } finally {
    await tree.cleanup();
  }
});

test('no repo typescript uses the bundled one', async () => {
  const tree = await makeTree({});
  try {
    const pick = loadTypeScript(tree.dir);
    assert.equal(pick.from, 'bundled');
    assert.equal(pick.version, ownVersion);
    assert.equal(pick.message, `Import links from the TypeScript ${ownVersion} in codereview-axi: this repo has no TypeScript.`);
  } finally {
    await tree.cleanup();
  }
});

test('typescript 7 without a JS API uses the bundled one', async () => {
  const tree = await makeTree({
    'node_modules/typescript/package.json': ts7Package,
    'node_modules/typescript/index.js': ts7Index,
  });
  try {
    const pick = loadTypeScript(tree.dir);
    assert.equal(pick.from, 'bundled');
    assert.equal(pick.version, ownVersion);
    assert.ok(pick.message.endsWith("this repo's TypeScript 7.0.2 has no JS API."), pick.message);
    assert.equal(pick.message, `Import links from the TypeScript ${ownVersion} in codereview-axi: this repo's TypeScript 7.0.2 has no JS API.`);
  } finally {
    await tree.cleanup();
  }
});

test('no fallback and no repo typescript', async () => {
  const tree = await makeTree({});
  try {
    const pick = loadTypeScript(tree.dir, { loadBundled: noFallback });
    assert.equal(pick.ts, null);
    assert.equal(pick.from, 'none');
    assert.equal(pick.version, null);
    assert.equal(pick.message, 'No import links: this repo has no TypeScript.');
  } finally {
    await tree.cleanup();
  }
});

test('no fallback and typescript 7', async () => {
  const tree = await makeTree({
    'node_modules/typescript/package.json': ts7Package,
    'node_modules/typescript/index.js': ts7Index,
  });
  try {
    const pick = loadTypeScript(tree.dir, { loadBundled: noFallback });
    assert.equal(pick.ts, null);
    assert.equal(pick.from, 'none');
    assert.equal(pick.message, "No import links: this repo's TypeScript 7.0.2 has no JS API.");
  } finally {
    await tree.cleanup();
  }
});

test('repo typescript with no version reads as unknown', async () => {
  const tree = await makeTree({
    'node_modules/typescript/package.json': ts7Package,
    'node_modules/typescript/index.js': 'module.exports = {};',
  });
  try {
    const pick = loadTypeScript(tree.dir, { loadBundled: noFallback });
    assert.equal(pick.message, "No import links: this repo's TypeScript unknown has no JS API.");
  } finally {
    await tree.cleanup();
  }
});
