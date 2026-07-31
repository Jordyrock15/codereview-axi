import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, readFile, writeFile, mkdir, readdir, stat, symlink, realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installHook, HOOK_MARKER } from '../../src/cli/setup.js';

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

test('installHook refuses a settings file that is valid JSON but not an object, rather than reporting "added" and writing nothing useful back', async () => {
  for (const [label, contents] of /** @type {[string, string][]} */ ([
    ['an array', '[]'],
    ['null', 'null'],
    ['a bare string', '"hello"'],
    ['a bare number', '42'],
  ])) {
    const p = await settingsIn(null);
    await writeFile(p, contents);
    await assert.rejects(() => installHook(p, 'cr'), /does not contain a JSON object/, `${label} must be refused`);
    assert.equal(await readFile(p, 'utf8'), contents, `${label}: the file must be left exactly as it was`);
  }
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

test('installHook refuses a settings file whose "hooks" is present but not a plain object, rather than crashing or dropping the hook', async () => {
  for (const [label, contents, expected] of /** @type {[string, Record<string, any>, RegExp][]} */ ([
    ['hooks as an array', { hooks: [1, 2] }, /"hooks" is not a JSON object/],
    ['hooks as a bare string', { hooks: 'nope' }, /"hooks" is not a JSON object/],
    ['hooks.SessionStart as an object, not an array', { hooks: { SessionStart: { a: 1 } } }, /"hooks\.SessionStart" is not an array/],
  ])) {
    const p = await settingsIn(contents);
    const before = await readFile(p, 'utf8');
    await assert.rejects(() => installHook(p, 'cr'), expected, label);
    assert.equal(await readFile(p, 'utf8'), before, `${label}: the file must be left exactly as it was`);
  }
});

test('installHook strips a leading UTF-8 BOM rather than refusing the file forever', async () => {
  const p = await settingsIn(null);
  await writeFile(p, `﻿${JSON.stringify({ permissions: { allow: [] } })}`);

  const result = await installHook(p, 'cr');
  assert.equal(result.action, 'added');

  const parsed = JSON.parse((await readFile(p, 'utf8')).replace(/^﻿/, ''));
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'cr');
  assert.deepEqual(parsed.permissions.allow, []);
});

test('installHook matches on the marker, not the command text, so an unrelated hook already using the same command is not mistaken for ours', async () => {
  const p = await settingsIn({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cr' }] }] },
  });

  const result = await installHook(p, 'cr');
  assert.equal(result.action, 'added', 'a same-text command with no marker must not read as already installed');

  const parsed = JSON.parse(await readFile(p, 'utf8'));
  const entries = parsed.hooks.SessionStart.flatMap((/** @type {any} */ e) => e.hooks);
  assert.equal(entries.length, 2, 'both the unrelated pre-existing entry and the new marked one must survive');
  assert.equal(entries.filter((/** @type {any} */ h) => h[HOOK_MARKER] === true).length, 1);

  const again = await installHook(p, 'cr');
  assert.equal(again.action, 'already-present', 'a rerun must recognise its own marked entry');
});

test('installHook skips the backup on a first install, there is nothing to back up', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-setup-'));
  const p = path.join(dir, 'settings.json');

  const result = await installHook(p, 'cr');
  assert.equal(result.action, 'added');
  await assert.rejects(() => readFile(`${p}.bak`), 'no backup should exist for a first install');
});

test('installHook backs up the exact previous contents before rewriting an existing file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-setup-'));
  const p = path.join(dir, 'settings.json');
  const original = `${JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }, null, 2)}\n`;
  await writeFile(p, original);

  const result = await installHook(p, 'cr');
  assert.equal(result.action, 'added');

  const backup = await readFile(`${p}.bak`, 'utf8');
  assert.equal(backup, original, 'the .bak must be a byte-identical copy of the file exactly as it was before this write');
});

test('installHook writes and leaves no stray temp file behind', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-setup-'));
  const p = path.join(dir, 'settings.json');
  await installHook(p, 'cr');

  const entries = await readdir(dir);
  assert.deepEqual(entries.sort(), ['settings.json'], 'a temp file left behind means the rename-based write did not complete cleanly');
});

test('installHook replaces an existing file via rename, not a truncate-in-place write', async () => {
  // A rename swaps the directory entry to a new inode; an in-place
  // writeFile/truncate keeps the original inode. This is the one thing that
  // actually tells the two write strategies apart, since both leave the
  // directory holding a single file with the expected final contents.
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-setup-'));
  const p = path.join(dir, 'settings.json');
  await writeFile(p, JSON.stringify({ permissions: { allow: [] } }));
  const before = (await stat(p)).ino;

  await installHook(p, 'cr');

  const after = (await stat(p)).ino;
  assert.notEqual(after, before, 'the inode must change: a truncate-in-place write would keep the same inode and risk a truncated file if interrupted');
});

test('installHook reports the real path when the settings file is a symlink, not the symlink itself', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-setup-'));
  const real = path.join(dir, 'real-settings.json');
  const link = path.join(dir, 'settings.json');
  await writeFile(real, JSON.stringify({ permissions: { allow: [] } }));
  await symlink(real, link);

  const result = await installHook(link, 'cr');
  assert.equal(result.action, 'added');
  assert.equal(result.path, await realpath(real), 'the destination reported must be the real file the symlink points at, not the symlink path');
  assert.notEqual(result.path, link);
});

test('installHook creates a new settings file at mode 0600, not the default 0644', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-setup-'));
  const p = path.join(dir, 'settings.json');
  await installHook(p, 'cr');

  const mode = (await stat(p)).mode & 0o777;
  assert.equal(mode, 0o600);
});
