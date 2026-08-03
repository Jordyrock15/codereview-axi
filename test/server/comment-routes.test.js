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

test('POST comments rejects an unrecognised scope', async (t) => {
  const { call, at } = await setup(t);
  const res = await call('POST', at('/comments'), lineBody({ scope: 'paragraph' }));
  assert.equal(res.status, 400);
  assert.match(res.json.error, /scope must be one of/);
});

test('POST comments rejects an unrecognised side on a line-scope comment', async (t) => {
  const { call, at } = await setup(t);
  const res = await call('POST', at('/comments'), lineBody({ side: 'sideways' }));
  assert.equal(res.status, 400);
  assert.match(res.json.error, /side must be one of/);
});

test('POST comments still accepts the documented scopes and sides', async (t) => {
  const { call, at } = await setup(t);
  assert.equal((await call('POST', at('/comments'), lineBody({ side: 'old', startLine: 1, endLine: 1, quote: 'one' }))).status, 201);
  assert.equal((await call('POST', at('/comments'), { scope: 'file', file: 'a.js', body: 'file note', verdict: 'explain' })).status, 201);
  assert.equal((await call('POST', at('/comments'), { scope: 'session', body: 'overall', verdict: 'ignore' })).status, 201);
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

test('POST comments refuses a quote whose line count does not match the range', async (t) => {
  const { call, at } = await setup(t);

  const res = await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 4,
    quote: 'TWO', body: 'three lines claimed, one supplied', verdict: 'fix',
  });

  assert.equal(res.status, 400);
  assert.match(res.json.error, /quote/);
});

test('POST comments accepts a blank quote on a one-line range', async (t) => {
  const { call, at } = await setup(t);

  // A blank line is a legitimate quote: ''.split('\n') is already length 1,
  // the right count for a one-line range. Only the line count is checked.
  const res = await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2,
    quote: '', body: 'the selected line is genuinely blank', verdict: 'fix',
  });

  assert.equal(res.status, 201);
});

test('POST comments refuses an empty quote on a multi-line range', async (t) => {
  const { call, at } = await setup(t);

  const res = await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 3,
    quote: '', body: 'two lines claimed, none supplied', verdict: 'fix',
  });

  assert.equal(res.status, 400);
});

test('POST comments accepts a multi-line quote matching its range', async (t) => {
  const { call, at } = await setup(t);

  const res = await call('POST', at('/comments'), {
    scope: 'line', file: 'a.js', side: 'new', startLine: 1, endLine: 2,
    quote: 'one\nTWO', body: 'two lines, two supplied', verdict: 'fix',
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.endLine, 2);
});

test('a session-scope comment needs no quote', async (t) => {
  const { call, at } = await setup(t);
  const res = await call('POST', at('/comments'), { scope: 'session', body: 'overall note', verdict: 'explain' });
  assert.equal(res.status, 201);
});

test('DELETE removes a queued comment and publishes it', async (t) => {
  const { call, at, hub } = await setup(t);
  await call('POST', at('/comments'), lineBody());

  /** @type {string[]} */
  const events = [];
  hub.publish = (k, event) => { events.push(event); return 1; };

  const res = await call('DELETE', at('/comments/1'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { id: 1, removed: true });
  assert.deepEqual(events, ['comment']);

  const session = (await call('GET', at(''))).json;
  assert.equal(session.comments.length, 0);
});

test('DELETE removes a reopened comment too', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), lineBody());
  await call('POST', at('/send'));
  await call('POST', at('/replies'), { id: 1, status: 'fixed', body: 'done' });
  await call('PATCH', at('/comments/1'), { status: 'reopened' });

  const res = await call('DELETE', at('/comments/1'));
  assert.equal(res.status, 200);
});

test('DELETE refuses a sent, answered or resolved comment', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), lineBody());
  await call('POST', at('/send'));
  assert.equal((await call('DELETE', at('/comments/1'))).status, 409);

  await call('POST', at('/replies'), { id: 1, status: 'fixed', body: 'done' });
  assert.equal((await call('DELETE', at('/comments/1'))).status, 409);

  await call('PATCH', at('/comments/1'), { status: 'resolved' });
  assert.equal((await call('DELETE', at('/comments/1'))).status, 409);
});

test('DELETE 404s an unknown id', async (t) => {
  const { call, at } = await setup(t);
  assert.equal((await call('DELETE', at('/comments/9'))).status, 404);
});

test('DELETE refuses on a closed session', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), lineBody());
  await call('POST', at('/close'), { closedBy: 'human' });
  assert.equal((await call('DELETE', at('/comments/1'))).status, 409);
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
