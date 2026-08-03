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

test('the same holder may re-poll, which is how a killed poll recovers', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  assert.equal((await call('GET', at('/pending?holder=111&timeout=1'))).json.comments.length, 1);
  assert.equal((await call('GET', at('/pending?holder=111&timeout=1'))).json.comments.length, 0);
});

test('comments are delivered at most once', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  const first = (await call('GET', at('/pending?holder=111&timeout=1'))).json;
  const second = (await call('GET', at('/pending?holder=111&timeout=1'))).json;

  assert.equal(first.comments.length, 1);
  assert.equal(second.comments.length, 0, 'a delivered comment is not re-delivered');
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

test('two concurrent polls from the same holder deliver a comment once, not twice', async (t) => {
  const { call, at } = await setup(t);
  await call('POST', at('/comments'), comment());
  await call('POST', at('/send'));

  // takeLease lets a holder re-enter, which is what makes re-polling work, so
  // the lease cannot be what keeps these two apart. Building the payload before
  // stamping opened a window where both could read the same comment and both
  // return it; at-most-once delivery has to survive that.
  //
  // Timing-dependent, so treat it as a smoke test rather than a proof:
  // Promise.all does not force both requests past the deciding read before
  // either stamps, so a broken build could pass if the first finished before the
  // second started reading. It does fail on an unlocked build in practice,
  // which is why it is here. Proving it deterministically needs an injection
  // seam in the context build that createApp does not currently offer.
  const [a, b] = await Promise.all([
    call('GET', at('/pending?holder=111&timeout=1')),
    call('GET', at('/pending?holder=111&timeout=1')),
  ]);

  const delivered = a.json.comments.length + b.json.comments.length;
  assert.equal(delivered, 1, 'the comment must arrive in exactly one of the two responses');
});
