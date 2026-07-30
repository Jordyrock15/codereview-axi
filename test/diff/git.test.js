import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { makeRepo } from '../helpers/repo.js';
import { toplevel, diffUnstaged, diffStaged, untrackedPaths, readWorkingFile } from '../../src/diff/git.js';

test('toplevel returns the worktree root', async (t) => {
  const repo = await makeRepo({ 'a.js': 'const a = 1;\n' });
  t.after(repo.cleanup);
  const top = await toplevel(repo.dir);
  assert.equal(path.basename(String(top)), path.basename(repo.dir));
});

test('toplevel returns null outside a repo', async () => {
  assert.equal(await toplevel(tmpdir()), null);
});

test('toplevel rejects with a clear message for a non-existent directory', async () => {
  await assert.rejects(() => toplevel('/no/such/directory/at/all'), /no such directory/);
});

test('diffUnstaged sees working tree edits', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');
  const out = await diffUnstaged(repo.dir);
  assert.match(out, /diff --git a\/a\.js b\/a\.js/);
  assert.match(out, /\+two/);
});

test('diffStaged sees only staged edits', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', 'a.js']);
  await repo.write('a.js', 'three\n');

  assert.match(await diffStaged(repo.dir), /\+two/);
  assert.match(await diffUnstaged(repo.dir), /\+three/);
});

test('untrackedPaths lists new files and respects gitignore', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n', '.gitignore': 'ignored.js\n' });
  t.after(repo.cleanup);
  await repo.write('new.js', 'fresh\n');
  await repo.write('ignored.js', 'hidden\n');

  const paths = await untrackedPaths(repo.dir);
  assert.deepEqual(paths, ['new.js']);
});

test('readWorkingFile returns contents and null for a missing file', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  assert.equal(await readWorkingFile(repo.dir, 'a.js'), 'one\n');
  assert.equal(await readWorkingFile(repo.dir, 'nope.js'), null);
});
