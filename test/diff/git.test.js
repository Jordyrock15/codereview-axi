import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, rm, symlink } from 'node:fs/promises';
import { makeRepo } from '../helpers/repo.js';
import {
  toplevel,
  mergeBase,
  diffWorking,
  untrackedPaths,
  readWorkingFile,
  isBinaryPath,
} from '../../src/diff/git.js';

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

test('diffWorking sees working tree edits', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');
  const out = await diffWorking(repo.dir);
  assert.match(out, /diff --git a\/a\.js b\/a\.js/);
  assert.match(out, /\+two/);
});

test('diffWorking sees staged edits too', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', 'a.js']);

  assert.match(await diffWorking(repo.dir), /\+two/);
});

test('diffWorking reports one diff when a file is staged then edited again', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', 'a.js']);
  await repo.write('a.js', 'three\n');

  const out = await diffWorking(repo.dir);
  assert.equal((out.match(/^diff --git/gm) ?? []).length, 1, 'one entry for one file');
  assert.match(out, /-one/);
  assert.match(out, /\+three/);
  assert.equal(/\+two/.test(out), false, 'the intermediate staged content is not part of HEAD vs worktree');
});

test('diffWorking resolves rather than rejects in a repo with no commits', async (t) => {
  const repo = await makeRepo({});
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\n');
  await repo.run(['add', 'a.js']);

  const out = await diffWorking(repo.dir);
  assert.match(out, /\+one/);
});

test('mergeBase finds the divergence point', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  const base = (await repo.run(['rev-parse', 'HEAD'])).trim();

  await repo.run(['checkout', '-q', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['commit', '-qam', 'branch work']);

  assert.equal(await mergeBase(repo.dir, 'main'), base);
});

test('mergeBase rejects a ref that does not exist', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  await assert.rejects(() => mergeBase(repo.dir, 'no-such-ref'), /no-such-ref/);
});

test('mergeBase rejects unrelated histories', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-q', '--orphan', 'unrelated']);
  await repo.write('b.js', 'other\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-qm', 'unrelated root']);

  await assert.rejects(() => mergeBase(repo.dir, 'main'), /common history/);
});

test('diffWorking against a base excludes independent work on that base', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n', 'other.js': 'base\n' });
  t.after(repo.cleanup);

  await repo.run(['checkout', '-q', '-b', 'feature']);
  await repo.write('a.js', 'from the branch\n');
  await repo.run(['commit', '-qam', 'branch work']);

  await repo.run(['checkout', '-q', 'main']);
  await repo.write('other.js', 'moved on\n');
  await repo.run(['commit', '-qam', 'independent work']);
  await repo.run(['checkout', '-q', 'feature']);

  const out = await diffWorking(repo.dir, 'main');

  assert.match(out, /a\.js/);
  assert.equal(/other\.js/.test(out), false, 'independent work on the base must not appear');
});

test('diffWorking against a base includes an uncommitted fix', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  await repo.run(['checkout', '-q', '-b', 'feature']);
  await repo.write('a.js', 'committed on the branch\n');
  await repo.run(['commit', '-qam', 'branch work']);
  await repo.write('a.js', 'and then fixed locally\n');

  const out = await diffWorking(repo.dir, 'main');

  assert.match(out, /and then fixed locally/);
  assert.equal(/committed on the branch/.test(out), false, 'the intermediate commit is not the surface');
});

test('diffWorking with no base behaves exactly as before', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  assert.equal(await diffWorking(repo.dir), await diffWorking(repo.dir, undefined));
  assert.match(await diffWorking(repo.dir), /\+two/);
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

test('readWorkingFile refuses a symlink pointing outside the repo', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const outside = path.join(tmpdir(), `cr-outside-${process.pid}.txt`);
  await writeFile(outside, 'SECRET\n');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(repo.dir, 'link.txt'));

  assert.equal(await readWorkingFile(repo.dir, 'link.txt'), null);
});

test('isBinaryPath refuses a symlink pointing outside the repo', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const outside = path.join(tmpdir(), `cr-outside-bin-${process.pid}.bin`);
  await writeFile(outside, Buffer.from([0x00, 0x01, 0x02]));
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(repo.dir, 'blob.bin'));

  assert.equal(await isBinaryPath(repo.dir, 'blob.bin'), false);
});

test('a symlink pointing inside the repo still reads', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await symlink(path.join(repo.dir, 'a.js'), path.join(repo.dir, 'alias.js'));

  assert.equal(await readWorkingFile(repo.dir, 'alias.js'), 'one\n');
});

test('an ordinary file in a repo under a symlinked root still reads', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  assert.equal(await readWorkingFile(repo.dir, 'a.js'), 'one\n');
});

test('a path escaping with .. is refused', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const outside = path.join(path.dirname(repo.dir), `cr-escape-${process.pid}.txt`);
  await writeFile(outside, 'SECRET\n');
  t.after(() => rm(outside, { force: true }));

  const result = await readWorkingFile(repo.dir, `../${path.basename(outside)}`);
  assert.notEqual(result, 'SECRET\n');
  assert.equal(result, null);
});
