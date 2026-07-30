import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { buildSnapshot } from '../../src/diff/snapshot.js';

/**
 * @param {any} snapshot
 * @param {string} path
 */
const find = (snapshot, path) => snapshot.files.find((/** @type {any} */ f) => f.path === path);

test('merges a partly staged file into one entry', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\ntwo\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'ONE\ntwo\n');
  await repo.run(['add', 'a.js']);
  await repo.write('a.js', 'ONE\nTWO\n');

  const snapshot = await buildSnapshot(repo.dir);
  const matches = snapshot.files.filter((f) => f.path === 'a.js');
  assert.equal(matches.length, 1, 'a partly staged file must appear once');
  assert.equal(snapshot.totals.files, 1);
});

test('includes untracked files as all-add', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('fresh.js', 'l1\nl2\nl3\n');

  const file = find(await buildSnapshot(repo.dir), 'fresh.js');
  assert.equal(file.status, 'added');
  assert.equal(file.added, 3);
  assert.equal(file.removed, 0);
  assert.ok(file.tags.includes('untracked'));
  assert.equal(file.hunks[0].lines.every((/** @type {any} */ l) => l.kind === 'add'), true);
  assert.equal(file.hunks[0].lines[2].newLine, 3);
});

test('tags an untracked binary file and emits no hunks', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('blob.bin', 'abc\u0000def');

  const file = find(await buildSnapshot(repo.dir), 'blob.bin');
  assert.equal(file.binary, true);
  assert.deepEqual(file.hunks, []);
  assert.ok(file.tags.includes('binary'));
});

test('tags generated paths and sorts them last', async (t) => {
  const repo = await makeRepo({ 'src/a.js': 'one\n', 'pnpm-lock.yaml': 'lock: 1\n' });
  t.after(repo.cleanup);
  await repo.write('src/a.js', 'two\n');
  await repo.write('pnpm-lock.yaml', 'lock: 2\n');

  const snapshot = await buildSnapshot(repo.dir);
  assert.ok(find(snapshot, 'pnpm-lock.yaml').tags.includes('generated'));
  assert.equal(find(snapshot, 'src/a.js').tags.includes('generated'), false);
  assert.equal(snapshot.files.at(-1)?.path, 'pnpm-lock.yaml');
});

test('tags dist and min paths as generated', async (t) => {
  const repo = await makeRepo({ 'dist/bundle.js': 'a\n', 'vendor/lib.min.js': 'a\n', 'test/x.snap': 'a\n' });
  t.after(repo.cleanup);
  await repo.write('dist/bundle.js', 'b\n');
  await repo.write('vendor/lib.min.js', 'b\n');
  await repo.write('test/x.snap', 'b\n');

  const snapshot = await buildSnapshot(repo.dir);
  for (const p of ['dist/bundle.js', 'vendor/lib.min.js', 'test/x.snap']) {
    assert.ok(find(snapshot, p).tags.includes('generated'), `${p} should be tagged generated`);
  }
});

test('tags a file over the large threshold', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('big.js', Array.from({ length: 1600 }, (_, i) => `line ${i}\n`).join(''));

  const file = find(await buildSnapshot(repo.dir), 'big.js');
  assert.ok(file.tags.includes('large'));
});

test('totals count files and lines', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n', 'b.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');
  await repo.write('b.js', 'one\nextra\n');

  const { totals } = await buildSnapshot(repo.dir);
  assert.equal(totals.files, 2);
  assert.equal(totals.added, 2);
  assert.equal(totals.removed, 1);
});

test('returns an empty snapshot for a clean tree', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  const snapshot = await buildSnapshot(repo.dir);
  assert.deepEqual(snapshot.files, []);
  assert.equal(snapshot.totals.files, 0);
});
