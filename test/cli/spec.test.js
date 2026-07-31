import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERBS, verbHelp, unknownFlags, USAGE, checkArity, booleanFlagNames,
} from '../../src/cli/spec.js';

test('every verb the CLI dispatches has a spec entry', async () => {
  const { COMMANDS } = await import('../../src/cli/commands.js');
  // Not the reverse: `help` has a spec entry (so the unknown-flag/arity/
  // positional gate applies to it) without being a dispatched HANDLERS
  // entry, since it is handled specially in run() rather than as a verb a
  // human picks from the menu.
  for (const verb of Object.keys(COMMANDS)) assert.ok(Object.hasOwn(VERBS, verb), `${verb} has no spec entry`);
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

test('booleanFlagNames includes the universal flags plus the verb\'s own', () => {
  assert.deepEqual([...booleanFlagNames('open')].sort(), ['help', 'json', 'no-browser', 'no-help', 'version'].sort());
  assert.deepEqual([...booleanFlagNames('reply')].sort(), ['help', 'json', 'no-help', 'version'].sort());
});

test('booleanFlagNames with no verb gives just the universal set', () => {
  assert.deepEqual([...booleanFlagNames()].sort(), ['help', 'json', 'no-help', 'version'].sort());
});

test('checkArity accepts a boolean flag with no value or with true', () => {
  assert.equal(checkArity('open', { 'no-browser': true }), null);
  assert.equal(checkArity('open', {}), null);
});

test('checkArity rejects a value on a flag declared with no argument', () => {
  assert.match(/** @type {string} */ (checkArity('open', { 'no-browser': 'false' })), /--no-browser/);
  assert.match(/** @type {string} */ (checkArity('list', { json: 'true' })), /--json/);
});

test('checkArity does not flag a valued flag with a real value', () => {
  assert.equal(checkArity('open', { note: 'hello' }), null);
});
