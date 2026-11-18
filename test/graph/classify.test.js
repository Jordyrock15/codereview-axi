import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile, isCodeFile } from '../../src/graph/classify.js';

/** @type {[string, string][]} */
const cases = [
  ['src/a.test.ts', 'test'], ['src/a.spec.js', 'test'], ['App/Tests/Thing.swift', 'test'],
  ['src/Fixtures/x.ts', 'test'], ['src/Button.stories.tsx', 'story'],
  ['src/types/order.ts', 'types'], ['src/Types/order.ts', 'types'], ['src/global.d.ts', 'types'],
  ['vite.config.ts', 'config'], ['package.json', 'config'], ['README.md', 'config'], ['flake.nix', 'config'],
  ['src/a.ts', 'source'], ['src/a.tsx', 'source'], ['bin/cr.js', 'source'], ['src/x.mjs', 'source'],
];
for (const [path, kind] of cases) test(`classify ${path}`, () => assert.equal(classifyFile(path), kind));
test('isCodeFile', () => {
  assert.equal(isCodeFile('a.cts'), true);
  assert.equal(isCodeFile('a.d.ts'), true);
  assert.equal(isCodeFile('a.json'), false);
});
