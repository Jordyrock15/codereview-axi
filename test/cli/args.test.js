import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../src/cli/args.js';

test('reads the verb from the first positional', () => {
  assert.equal(parseArgs(['open']).verb, 'open');
});

test('defaults the verb to help when argv is empty', () => {
  assert.equal(parseArgs([]).verb, 'help');
});

test('reads --flag value pairs', () => {
  const { flags } = parseArgs(['wait', '--timeout', '300', '--say', 'check the rounding']);
  assert.equal(flags.timeout, '300');
  assert.equal(flags.say, 'check the rounding');
});

test('treats a flag with no value as boolean true', () => {
  assert.equal(parseArgs(['open', '--no-browser']).flags['no-browser'], true);
});

test('treats a flag followed by another flag as boolean true', () => {
  const { flags } = parseArgs(['open', '--quiet', '--note', 'hello']);
  assert.equal(flags.quiet, true);
  assert.equal(flags.note, 'hello');
});

test('collects extra positionals', () => {
  assert.deepEqual(parseArgs(['reply', 'extra']).positional, ['extra']);
});

test('supports --flag=value', () => {
  assert.equal(parseArgs(['wait', '--timeout=120']).flags.timeout, '120');
});
