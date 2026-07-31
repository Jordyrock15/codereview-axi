import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, readFile, writeFile, mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installHook } from '../../src/cli/setup.js';

/** @param {Record<string, any>|null} contents */
const settingsIn = async (contents) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-setup-'));
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  const p = path.join(dir, '.claude', 'settings.local.json');
  if (contents !== null) await writeFile(p, JSON.stringify(contents, null, 2));
  return p;
};

test('installHook creates the file when none exists', async () => {
  const p = await settingsIn(null);
  const result = await installHook(p, 'cr');
  assert.equal(result.action, 'added');

  const parsed = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'cr');
});

test('installHook preserves unrelated settings and unrelated hooks', async () => {
  const p = await settingsIn({
    permissions: { allow: ['Bash(git *)'] },
    hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier' }] }] },
  });
  await installHook(p, 'cr');

  const parsed = JSON.parse(await readFile(p, 'utf8'));
  assert.deepEqual(parsed.permissions.allow, ['Bash(git *)']);
  assert.equal(parsed.hooks.PostToolUse[0].hooks[0].command, 'prettier');
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'cr');
});

test('installHook is idempotent and reports so', async () => {
  const p = await settingsIn(null);
  await installHook(p, 'cr');
  const before = await readFile(p, 'utf8');

  const again = await installHook(p, 'cr');
  assert.equal(again.action, 'already-present');
  assert.equal(await readFile(p, 'utf8'), before, 'the file must be byte-identical');
});

test('installHook refuses malformed JSON rather than overwriting it', async () => {
  const p = await settingsIn(null);
  await writeFile(p, '{ not json');
  await assert.rejects(() => installHook(p, 'cr'), /could not read/);
  assert.equal(await readFile(p, 'utf8'), '{ not json', 'the file must be left alone');
});

test('installHook adds alongside an existing SessionStart hook rather than replacing it', async () => {
  const p = await settingsIn({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }] },
  });
  await installHook(p, 'cr');

  const parsed = JSON.parse(await readFile(p, 'utf8'));
  const commands = parsed.hooks.SessionStart.flatMap((/** @type {any} */ e) => e.hooks.map((/** @type {any} */ h) => h.command));
  assert.deepEqual(commands.sort(), ['cr', 'echo hello']);
});
