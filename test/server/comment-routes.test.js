import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {string} [contents]
 * @param {string} [edited]
 */
const setup = async (t, contents = 'one\ntwo\nthree\n', edited = 'one\nTWO\nthree\n') => {
  const repo = await makeRepo({ 'a.js': contents });
  t.after(repo.cleanup);
  await repo.write('a.js', edited);

  const app = await startApp(t);
  const { key, token } = (await app.call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  /** @param {string} path */
  const at = (path) => `/api/sessions/${key}${path}${path.includes('?') ? '&' : '?'}t=${token}`;
  return { ...app, repo, key, token, at };
};

const lineBody = (overrides = {}) => ({
  scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2,
  quote: 'TWO', body: 'this loses pennies', verdict: 'fix', ...overrides,
});

test('POST comments creates one and publishes it', async (t) => {
  const { call, at, hub } = await setup(t);
  /** @type {string[]} */
  const events = [];
  hub.publish = (k, event) => { events.push(event); return 1; };

  const res = await call('POST', at('/comments'), lineBody());

  assert.equal(res.status, 201);
  assert.equal(res.json.id, 1);
  assert.equal(res.json.status, 'open');
  assert.equal(res.json.verdict, 'fix');
  assert.deepEqual(events, ['comment']);
});

test('POST comments rejects an empty body and an unknown verdict', async (t) => {
  const { call, at } = await setup(t);
  assert.equal((await call('POST', at('/comments'), lineBody({ body: '  ' }))).status, 400);
  assert.equal((await call('POST', at('/comments'), lineBody({ verdict: 'maybe' }))).status, 400);
});

test('POST comments refuses to add to a closed session', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/close'), { closedBy: 'human' });
  const res = await call('POST', at('/comments'), lineBody());
  assert.equal(res.status, 409);
});

test('PATCH edits body and verdict', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), lineBody());
  const res = await call('PATCH', at('/comments/1'), { body: 'clearer', verdict: 'explain' });
  assert.equal(res.json.body, 'clearer');
  assert.equal(res.json.verdict, 'explain');
});

test('PATCH resolve is refused until the agent has replied, then allowed', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), lineBody());
  assert.equal((await call('PATCH', at('/comments/1'), { status: 'resolved' })).status, 409);

  await call('POST', at('/send'));
  await call('POST', at('/replies'), { id: 1, status: 'fixed', body: 'done' });

  assert.equal((await call('PATCH', at('/comments/1'), { status: 'resolved' })).json.status, 'resolved');
  assert.equal((await call('PATCH', at('/comments/1'), { status: 'reopened' })).json.status, 'reopened');
});

test('PATCH 404s an unknown id', async (t) => {
  const { call, at } = await setup(t);
  assert.equal((await call('PATCH', at('/comments/9'), { body: 'x' })).status, 404);
});

test('POST send marks open comments sent and reports the count', async (t) => {
  const { call, at, hub } = await setup(t);
  await call('POST', at('/comments'), lineBody());
  await call('POST', at('/comments'), lineBody({ startLine: 3, endLine: 3, quote: 'three' }));

  /** @type {string[]} */
  const events = [];
  hub.publish = (k, event) => { events.push(event); return 1; };

  const res = await call('POST', at('/send'));
  assert.equal(res.status, 200);
  assert.equal(res.json.sent, 2);
  assert.ok(events.includes('sent'));
});

test('POST send with nothing open is a no-op that does not wake anyone', async (t) => {
  const { call, at, hub } = await setup(t);
  /** @type {string[]} */
  const events = [];
  hub.publish = (k, event) => { events.push(event); return 1; };

  const res = await call('POST', at('/send'));
  assert.equal(res.status, 200);
  assert.equal(res.json.sent, 0);
  assert.deepEqual(events, []);
});

test('POST replies moves a sent comment to answered', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), lineBody());
  await call('POST', at('/send'));

  const res = await call('POST', at('/replies'), { id: 1, status: 'fixed', body: 'remainder distributed' });
  assert.equal(res.json.status, 'answered');
  assert.equal(res.json.agentReply.status, 'fixed');
});

test('POST replies 409s an unsent comment and 404s an unknown id', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), lineBody());
  assert.equal((await call('POST', at('/replies'), { id: 1, status: 'fixed', body: 'x' })).status, 409);
  assert.equal((await call('POST', at('/replies'), { id: 9, status: 'fixed', body: 'x' })).status, 404);
});

test('GET stream sends SSE headers and no CORS header', async (t) => {
  const { base, key, token } = await setup(t);
  const controller = new AbortController();
  t.after(() => controller.abort());

  const res = await fetch(`${base}/api/sessions/${key}/stream?t=${token}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('GET stream 401s without a token', async (t) => {
  const { base, key } = await setup(t);
  const res = await fetch(`${base}/api/sessions/${key}/stream`);
  assert.equal(res.status, 401);
});

test('PATCH note replaces the note and publishes it', async (t) => {
  const { call, at, hub } = await setup(t);
  /** @type {string[]} */
  const events = [];
  hub.publish = (k, event) => { events.push(event); return 1; };

  const res = await call('PATCH', at('/note'), { note: 'check the rounding first' });
  assert.equal(res.json.note, 'check the rounding first');
  assert.deepEqual(events, ['note']);
  assert.equal((await call('GET', at(''))).json.note, 'check the rounding first');
});
