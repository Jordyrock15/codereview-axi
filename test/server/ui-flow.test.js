import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';

/**
 * @param {import('node:test').TestContext} t
 */
const setup = async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\ntwo\nthree\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\nTWO\nthree\n');

  const app = await startApp(t);
  const { key, token } = (await app.call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  /** @param {string} path */
  const at = (path) => `/api/sessions/${key}${path}${path.includes('?') ? '&' : '?'}t=${token}`;
  return { ...app, repo, key, token, at };
};

test('the sequence a range comment performs leaves one open comment spanning two lines', async (t) => {
  const { call, at } = await setup(t);

  const created = await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 3,
    quote: 'TWO\nthree', body: 'these two belong together', verdict: 'fix',
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.startLine, 2);
  assert.equal(created.json.endLine, 3);

  const session = (await call('GET', at(''))).json;
  assert.equal(session.comments.length, 1);
  assert.equal(session.comments[0].status, 'open');
});

test('the sequence Send performs reports the count the button showed', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'TWO', body: 'one', verdict: 'fix',
  });
  await call('POST', at('/comments'), { scope: 'session', body: 'overall note', verdict: 'explain' });

  assert.equal((await call('POST', at('/send'))).json.sent, 2);
});

test('the sequence a follow-up performs puts an answered comment back in the unsent count', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'TWO', body: 'x', verdict: 'fix',
  });
  await call('POST', at('/send'));
  await call('POST', at('/replies'), { id: 1, status: 'fixed', body: 'done' });

  await call('POST', at('/comments/1/followup'), { body: 'also check the other branch' });

  assert.equal((await call('POST', at('/send'))).json.sent, 1);
});

test('the sequence Done performs closes the session as human', async (t) => {
  const { call, at } = await setup(t);
  const res = await call('POST', at('/close'), { closedBy: 'human' });
  assert.equal(res.json.closedBy, 'human');
});

test('a live SSE subscriber receives comment, sent, refreshed and closed events', async (t) => {
  const { base, call, at, key, token } = await setup(t);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${base}/api/sessions/${key}/stream?t=${token}`, { signal: controller.signal });
  const reader = /** @type {ReadableStream<Uint8Array>} */ (stream.body).getReader();
  const decoder = new TextDecoder();

  /**
   * Reads until the named event arrives or the attempt budget runs out.
   * @param {string} name
   */
  const expect = async (name) => {
    for (let i = 0; i < 40; i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      if (chunk.includes(`event: ${name}`)) return true;
    }
    return false;
  };

  await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'TWO', body: 'x', verdict: 'fix',
  });
  assert.equal(await expect('comment'), true);

  await call('POST', at('/send'));
  assert.equal(await expect('sent'), true);

  await call('POST', at('/refresh'));
  assert.equal(await expect('refreshed'), true);

  await call('POST', at('/close'), { closedBy: 'human' });
  assert.equal(await expect('closed'), true);
});

test('the quote the UI sends is what re-anchoring later relies on', async (t) => {
  const { call, at, repo } = await setup(t);
  await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'TWO', body: 'x', verdict: 'fix',
  });

  await repo.write('a.js', 'zero\none\nTWO\nthree\n');
  const refreshed = await call('POST', at('/refresh'));

  assert.deepEqual(refreshed.json.relocated, [1]);
  assert.equal((await call('GET', at(''))).json.comments[0].startLine, 3);
});
