import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { expandContext, commentContext } from '../../src/diff/context.js';

const twenty = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('returns the requested inclusive range', async (t) => {
  const repo = await makeRepo({ 'a.js': twenty });
  t.after(repo.cleanup);
  const out = await expandContext(repo.dir, 'a.js', 5, 8);
  assert.deepEqual(out, { from: 5, to: 8, lines: ['line 5', 'line 6', 'line 7', 'line 8'] });
});

test('clamps to the file bounds', async (t) => {
  const repo = await makeRepo({ 'a.js': twenty });
  t.after(repo.cleanup);
  const out = await expandContext(repo.dir, 'a.js', -4, 999);
  assert.equal(out.from, 1);
  assert.equal(out.to, 20);
  assert.equal(out.lines.length, 20);
});

test('returns empty lines for a missing file', async (t) => {
  const repo = await makeRepo({ 'a.js': twenty });
  t.after(repo.cleanup);
  assert.deepEqual(await expandContext(repo.dir, 'gone.js', 1, 5), { from: 1, to: 5, lines: [] });
});

test('commentContext returns radius lines either side', async (t) => {
  const repo = await makeRepo({ 'a.js': twenty });
  t.after(repo.cleanup);
  const { before, after } = await commentContext(repo.dir, 'a.js', 10, 11, 8);
  assert.deepEqual(before, ['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
  assert.deepEqual(after, ['line 12', 'line 13', 'line 14', 'line 15', 'line 16', 'line 17', 'line 18', 'line 19']);
});

test('commentContext clamps near the start of the file', async (t) => {
  const repo = await makeRepo({ 'a.js': twenty });
  t.after(repo.cleanup);
  const { before } = await commentContext(repo.dir, 'a.js', 2, 2, 8);
  assert.deepEqual(before, ['line 1']);
});
