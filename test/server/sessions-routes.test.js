import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';

test('POST /api/sessions creates a session and returns file metadata but no hunks', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: 'changed a' });

  assert.equal(res.status, 201);
  assert.match(res.json.key, /^[0-9a-f]{16}$/);
  assert.match(res.json.token, /^[0-9a-f]{64}$/);
  assert.equal(res.json.reused, false);
  assert.deepEqual(res.json.files.map((/** @type {{path: string}} */ f) => f.path), ['a.js']);
  assert.equal(res.json.files[0].added, 1);
  assert.equal(res.json.files[0].hunks, undefined, 'never ship hunks to the agent');
  assert.equal(res.json.totals.files, 1);
  assert.match(res.json.url, /^http:\/\/127\.0\.0\.1:\d+\/session\/[0-9a-f]{16}\?t=[0-9a-f]{64}$/);
});

test('POST /api/sessions 422s a clean tree so the CLI can exit 2', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: '' });

  assert.equal(res.status, 422);
  assert.match(res.json.error, /nothing to review/);
});

test('POST /api/sessions 400s a path that is not a git worktree', async (t) => {
  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: '/', note: '' });
  assert.equal(res.status, 400);
});

test('POST /api/sessions after a close starts fresh with a new token', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const first = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'first' })).json;
  await call('POST', `/api/sessions/${first.key}/close?t=${first.token}`, { closedBy: 'human' });

  const second = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'second' })).json;
  assert.equal(second.reused, false);
  assert.notEqual(second.token, first.token);
  assert.equal(second.comments.length, 0);
});

test('GET /api/sessions/:key returns the full session including hunks for the browser', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  const res = await call('GET', `/api/sessions/${key}?t=${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.json.snapshot.files[0].hunks.length > 0, 'the browser does get hunks');
  assert.equal(res.json.token, undefined, 'never echo the token back in session state');
});

test('GET /api/sessions/:key 401s without a token and 404s for an unknown key', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  assert.equal((await call('GET', `/api/sessions/${key}`)).status, 401);
  assert.equal((await call('GET', `/api/sessions/deadbeefdeadbeef?t=${token}`)).status, 404);
});

test('POST close records closedBy and publishes closed', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call, hub } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  /** @type {string[]} */
  const published = [];
  hub.publish = (k, event, data) => { published.push(event); return 1; };

  const res = await call('POST', `/api/sessions/${key}/close?t=${token}`, { closedBy: 'human' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'closed');
  assert.equal(res.json.closedBy, 'human');
  assert.ok(published.includes('closed'));
});

test('close defaults closedBy to agent and rejects an unknown value', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  assert.equal((await call('POST', `/api/sessions/${key}/close?t=${token}`, { closedBy: 'cat' })).status, 400);
  const res = await call('POST', `/api/sessions/${key}/close?t=${token}`, {});
  assert.equal(res.json.closedBy, 'agent');
});

test('a request with a foreign Host is refused even with a valid token', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call, port } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  // undici rewrites Host, so send a genuinely foreign one with node:http.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/sessions/${key}?t=${token}`,
        method: 'GET',
        headers: { Host: 'evil.example.com' },
      },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); },
    );
    req.on('error', reject);
    req.end();
  });

  assert.equal(status, 403);
});

test('refresh on a closed session is refused and leaves its snapshot untouched', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  await call('POST', `/api/sessions/${key}/close?t=${token}`, { closedBy: 'human' });
  const before = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;

  await repo.write('a.js', 'three\n');
  const res = await call('POST', `/api/sessions/${key}/refresh?t=${token}`);
  assert.equal(res.status, 409);

  const after = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;
  assert.equal(after.snapshotAt, before.snapshotAt);
});

test('POST /api/sessions from a foreign Host is refused', async (t) => {
  const { port } = await startApp(t);

  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/sessions',
        method: 'POST',
        headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' },
      },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ repo: '/', note: '' }));
  });

  assert.equal(status, 403);
});

test('creating a session reaps sessions abandoned for over a day', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  let clock = 1_800_000_000_000;
  const { call } = await startApp(t, { now: () => clock });

  const first = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  clock += 25 * 60 * 60 * 1000;
  const other = await makeRepo({ 'b.js': 'one\n' });
  t.after(other.cleanup);
  await other.write('b.js', 'two\n');
  await call('POST', '/api/sessions', { repo: other.dir, note: 'n' });

  assert.equal((await call('GET', `/api/sessions/${first.key}?t=${first.token}`)).json.status, 'closed');
});

test('POST /api/sessions reuses an open session and keeps its comments', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const first = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'first' })).json;

  await call('POST', `/api/sessions/${first.key}/comments?t=${first.token}`, {
    scope: 'line', file: 'a.js', side: 'new', startLine: 1, endLine: 1, quote: 'two', body: 'keep me', verdict: 'fix',
  });

  const second = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'second' })).json;

  assert.equal(second.reused, true);
  assert.equal(second.token, first.token);
  assert.equal(second.comments.length, 1);
  assert.equal(second.note, 'second');
});
test('POST /api/sessions re-anchors an open comment on reuse, not just on refresh', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\ntwo\nthree\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\nCHANGED\nthree\n');

  const { call } = await startApp(t);
  const first = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  await call('POST', `/api/sessions/${first.key}/comments?t=${first.token}`, {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'CHANGED', body: 'move this', verdict: 'fix',
  });

  await repo.write('a.js', 'zero\none\nCHANGED\nthree\n');
  const second = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  assert.equal(second.reused, true);
  assert.equal(second.comments[0].startLine, 3, 'a second cr open must re-anchor, not just leave the old line number');
});

test('POST /api/sessions with no note leaves an existing note untouched on reuse', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const first = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'set by the agent' })).json;

  const bare = (await call('POST', '/api/sessions', { repo: repo.dir })).json;
  assert.equal(bare.reused, true);
  assert.equal(bare.note, 'set by the agent', 'a bare cr open must not wipe the earlier note');
});

test('POST refresh recomputes the diff, re-anchors, and publishes to subscribers', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\ntwo\nthree\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\nCHANGED\nthree\n');

  const { call, hub } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  await call('POST', `/api/sessions/${key}/comments?t=${token}`, {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'CHANGED', body: 'move this', verdict: 'fix',
  });

  /** @type {{k: string, event: string, data: unknown}[]} */
  const published = [];
  hub.publish = (k, event, data) => { published.push({ k, event, data }); return 1; };

  await repo.write('a.js', 'zero\none\nCHANGED\nthree\n');
  const res = await call('POST', `/api/sessions/${key}/refresh?t=${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.json.relocated.length, 1);
  assert.deepEqual(res.json.stale, []);
  assert.equal(published[0].event, 'refreshed');

  const state = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;
  assert.equal(state.comments[0].startLine, 3);
});
test('POST refresh marks a comment stale when its quote is gone', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\ntwo\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\nTWO\n');

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  await call('POST', `/api/sessions/${key}/comments?t=${token}`, {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'TWO', body: 'x', verdict: 'fix',
  });

  await repo.write('a.js', 'one\nsomething else\n');
  const res = await call('POST', `/api/sessions/${key}/refresh?t=${token}`);
  assert.deepEqual(res.json.stale, [1]);
});
