import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERBS, verbHelp, unknownFlags, USAGE } from '../../src/cli/spec.js';

test('every verb the CLI dispatches has a spec entry', async () => {
  const { COMMANDS } = await import('../../src/cli/commands.js');
  assert.deepEqual(Object.keys(VERBS).sort(), Object.keys(COMMANDS).sort());
});

test('unknownFlags names a flag the verb does not declare', () => {
  assert.deepEqual(unknownFlags('open', { note: 'x', 'nonsense-flag': true }), ['nonsense-flag']);
  assert.deepEqual(unknownFlags('open', { note: 'x', base: 'main' }), []);
});

test('help is accepted on every verb', () => {
  for (const verb of Object.keys(VERBS)) assert.deepEqual(unknownFlags(verb, { help: true }), []);
});

test('a flag declared on one verb is not silently accepted on another', () => {
  assert.deepEqual(unknownFlags('close', { base: 'main' }), ['base']);
});

test('verbHelp names only that verb', () => {
  const help = verbHelp('reply');
  assert.match(help, /cr reply/);
  assert.match(help, /--status/);
  assert.equal(/--no-browser/.test(help), false, 'open-only flags must not appear under reply');
});

test('USAGE lists every verb', () => {
  for (const verb of Object.keys(VERBS)) assert.match(USAGE, new RegExp(`\\b${verb}\\b`));
});
