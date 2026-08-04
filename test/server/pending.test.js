import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';

const twenty = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** @param {import('node:test').TestContext} t */
const setup = async (t) => {
  const repo = await makeRepo({ 'a.js': twenty });
  t.after(repo.cleanup);
  await repo.write('a.js', twenty.replace('line 10', 'CHANGED 10'));

  const app = await startApp(t);
  const { key, token } = (await app.call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  /** @param {string} path */
  const at = (path) => `/api/sessions/${key}${path}${path.includes('?') ? '&' : '?'}t=${token}`;
  return { ...app, repo, key, token, at };
};

const comment = (overrides = {}) => ({
  scope: 'line', file: 'a.js', side: 'new', startLine: 10, endLine: 10,
  quote: 'CHANGED 10', body: 'rounding is wrong', verdict: 'fix', ...overrides,
});

test('pending returns immediately with already-sent comments', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  const res = await call('GET', at('/pending?holder=111&timeout=1'));
  assert.equal(res.status, 200);
  assert.equal(res.json.comments.length, 1);
  assert.equal(res.json.comments[0].body, 'rounding is wrong');
  assert.equal(res.json.closed, false);
});

test('each pending comment carries eight lines of context either side', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  const [first] = (await call('GET', at('/pending?holder=111&timeout=1'))).json.comments;
  assert.equal(first.context.before.length, 8);
  assert.equal(first.context.after.length, 8);
  assert.equal(first.context.before.at(-1), 'line 9');
  assert.equal(first.context.after[0], 'line 11');
});

test('pending returns an empty array on timeout rather than hanging', async (t) => {
  const { call, at } = await setup(t);
  const started = Date.now();
  const res = await call('GET', at('/pending?holder=111&timeout=1'));

  assert.equal(res.status, 200);
  assert.deepEqual(res.json.comments, []);
  assert.ok(Date.now() - started >= 900, 'it should actually wait out the timeout');
});

test('a waiting poll is woken by a send', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());

  const polling = call('GET', at('/pending?holder=111&timeout=20'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await call('POST', at('/send'));

  const res = await polling;
  assert.equal(res.json.comments.length, 1);
});

test('a second holder polling a leased session gets 409', async (t) => {
  const { call, at } = await setup(t);
  // holder must be a pid that is actually running: a lease whose holder has
  // exited is treated as free, which is the point of the liveness check.
  const first = call('GET', at(`/pending?holder=${process.pid}&timeout=5`));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const second = await call('GET', at(`/pending?holder=${process.pid + 1}&timeout=5`));
  assert.equal(second.status, 409);
  assert.match(second.json.error, /another agent is waiting/);

  await call('POST', at('/send'));
  await first;
});

test('a killed poll loses nothing, because an unacked comment comes back', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  // The first poll stands in for one whose response never reached the agent: it
  // read the comment and then died without acking. Sixteen real comments were
  // lost to that, so the redelivery here is the whole point of the ack.
  assert.equal((await call('GET', at('/pending?holder=111&timeout=1'))).json.comments.length, 1);
  assert.equal((await call('GET', at('/pending?holder=111&timeout=1'))).json.comments.length, 1,
    'without an ack the comment must still be deliverable');
});

test('an acked comment is not delivered again', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  const [first] = (await call('GET', at('/pending?holder=111&timeout=1'))).json.comments;
  const ack = await call('POST', at('/pending/ack'), { delivered: [{ id: first.id, updatedAt: first.updatedAt }] });
  assert.deepEqual(ack.json.acked, [first.id]);

  assert.equal((await call('GET', at('/pending?holder=111&timeout=1'))).json.comments.length, 0);
});

test('acking twice is harmless', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  const [first] = (await call('GET', at('/pending?holder=111&timeout=1'))).json.comments;
  const body = { delivered: [{ id: first.id, updatedAt: first.updatedAt }] };
  assert.deepEqual((await call('POST', at('/pending/ack'), body)).json.acked, [first.id]);
  // A retried ack must not error: the CLI may send it again after a transport hiccup.
  assert.deepEqual((await call('POST', at('/pending/ack'), body)).json.acked, []);
});

test('an ack whose comment has changed since delivery does not consume it', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  const [first] = (await call('GET', at('/pending?holder=111&timeout=1'))).json.comments;
  await call('PATCH', at(`/comments/${first.id}`), { body: 'actually, ignore the rounding' });

  // The delivered payload carried the old text, so stamping on a bare id would
  // lose the edit exactly as the old stamp-first code did.
  assert.deepEqual((await call('POST', at('/pending/ack'), { delivered: [{ id: first.id, updatedAt: first.updatedAt }] })).json.acked, []);
  const again = (await call('GET', at('/pending?holder=111&timeout=1'))).json.comments;
  assert.equal(again.length, 1);
  assert.equal(again[0].body, 'actually, ignore the rounding');
});

test('ack rejects a body that is not a delivered array', async (t) => {
  const { call, at } = await setup(t);
  assert.equal((await call('POST', at('/pending/ack'), {})).status, 400);
  assert.equal((await call('POST', at('/pending/ack'), { delivered: [{ updatedAt: 'x' }] })).status, 400);
});

test('delivery is at-least-once: acked comments stop coming, unacked ones do not', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  const first = (await call('GET', at('/pending?holder=111&timeout=1'))).json;
  assert.equal(first.comments.length, 1);

  await call('POST', at('/pending/ack'), {
    delivered: first.comments.map((/** @type {any} */ c) => ({ id: c.id, updatedAt: c.updatedAt })),
  });

  const second = (await call('GET', at('/pending?holder=111&timeout=1'))).json;
  assert.equal(second.comments.length, 0, 'an acked comment is not re-delivered');
});

test('pending reports a session the human closed', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/close'), { closedBy: 'human' });

  const res = await call('GET', at('/pending?holder=111&timeout=1'));
  assert.equal(res.json.closed, true);
  assert.equal(res.json.closedBy, 'human');
  assert.deepEqual(res.json.comments, []);
});

test('a waiting poll is woken by a close', async (t) => {
  const { call, at } = await setup(t);
  const polling = call('GET', at('/pending?holder=111&timeout=20'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await call('POST', at('/close'), { closedBy: 'human' });

  const res = await polling;
  assert.equal(res.json.closed, true);
});

test('pending releases the lease when it returns', async (t) => {
  const { call, at } = await setup(t);
  await call('GET', at('/pending?holder=111&timeout=1'));
  const res = await call('GET', at('/pending?holder=222&timeout=1'));
  assert.equal(res.status, 200);
});

test('concurrent polls from the same holder never lose a comment', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  // Under acknowledged delivery the invariant is that nothing is lost, not that
  // nothing repeats: neither poll has acked, so both are entitled to the
  // comment. takeLease already stops two different agents overlapping, and a
  // duplicate costs the agent a second look while a loss costs the human their
  // review. The old assertion here was exactly-once, which stopped being true
  // the moment the poll stopped stamping.
  const [a, b] = await Promise.all([
    call('GET', at('/pending?holder=111&timeout=1')),
    call('GET', at('/pending?holder=111&timeout=1')),
  ]);

  const delivered = a.json.comments.length + b.json.comments.length;
  assert.ok(delivered >= 1, 'at least one poll must carry the comment');

  const carrier = a.json.comments[0] ?? b.json.comments[0];
  await call('POST', at('/pending/ack'), { delivered: [{ id: carrier.id, updatedAt: carrier.updatedAt }] });
  assert.equal((await call('GET', at('/pending?holder=111&timeout=1'))).json.comments.length, 0,
    'one ack ends it, whichever poll carried it');
});
