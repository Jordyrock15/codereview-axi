import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRepo } from '../helpers/repo.js';

/** @param {import('node:test').TestContext} t */
const setup = async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  process.env.CODEREVIEW_AXI_HOME = home;

  const { run } = await import('../../src/cli/commands.js');
  const { readServerFile } = await import('../../src/server/index.js');
  const { shutdown } = await import('../../src/cli/client.js');

  // t.after runs hooks in registration order, so this must be registered
  // before the env deletion below or readServerFile looks in the wrong home.
  t.after(async () => {
    const info = await readServerFile();
    if (info) await shutdown(info.port, info.pid).catch(() => {});
  });

  t.after(() => { delete process.env.CODEREVIEW_AXI_HOME; });

  const repo = await makeRepo({ 'a.js': 'one\ntwo\nthree\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\nTWO\nthree\n');

  /** @param {string[]} argv */
  const cr = (argv) => run({ argv: [...argv, '--no-browser'], cwd: repo.dir, env: process.env });
  return { cr, repo, run };
};

test('open prints session metadata as JSON and exits 0', async (t) => {
  const { cr } = await setup(t);
  const result = await cr(['open', '--note', 'changed a']);

  assert.equal(result.code, 0);
  const json = JSON.parse(result.out);
  assert.match(json.key, /^[0-9a-f]{16}$/);
  assert.match(json.url, /^http:\/\/127\.0\.0\.1:\d+\/session\//);
  assert.deepEqual(json.files.map((/** @type {{path: string}} */ f) => f.path), ['a.js']);
  assert.equal(json.token, undefined, 'never print the token to stdout');
  assert.equal(json.files[0].hunks, undefined);
});

test('open --base main prints a diff containing the branch commit, unlike a bare open', async (t) => {
  const { cr, repo } = await setup(t);
  await repo.run(['checkout', '--', 'a.js']);
  await repo.run(['checkout', '-b', 'feature']);
  await repo.write('a.js', 'one\ncommitted change\nthree\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', 'branch change']);

  const bare = await cr(['open']);
  assert.equal(bare.code, 2, 'a bare open sees a clean tree relative to HEAD');

  const withBase = await cr(['open', '--base', 'main']);
  assert.equal(withBase.code, 0);
  const json = JSON.parse(withBase.out);
  assert.equal(json.base, 'main');
  assert.deepEqual(json.files.map((/** @type {{path: string}} */ f) => f.path), ['a.js']);
});

test('open exits 2 on a clean tree', async (t) => {
  const { cr, repo } = await setup(t);
  await repo.run(['checkout', '--', 'a.js']);
  const result = await cr(['open']);
  assert.equal(result.code, 2);
  assert.match(result.out, /nothing to review/);
});

test('open exits 1 outside a git worktree', async (t) => {
  const { run } = await setup(t);
  const result = await run({ argv: ['open', '--no-browser'], cwd: tmpdir(), env: process.env });
  assert.equal(result.code, 1);
  assert.match(result.out, /not inside a git worktree/);
});

test('list prints comments for the cwd session', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['list']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out).comments, []);
});

test('a verb other than open exits 1 when no session exists for the cwd', async (t) => {
  const { cr } = await setup(t);
  const result = await cr(['list']);
  assert.equal(result.code, 1);
  assert.match(result.out, /no open session/);
});

test('wait returns an empty comment array on timeout', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['wait', '--timeout', '1']);

  assert.equal(result.code, 0);
  const json = JSON.parse(result.out);
  assert.deepEqual(json.comments, []);
  assert.equal(json.closed, false);
});

test('wait --say posts a chat line before waiting', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['wait', '--timeout', '1', '--say', 'check the rounding first']);
  assert.equal(result.code, 0);
});

test('wait --say updates the note and creates no comment', async (t) => {
  const { cr } = await setup(t);
  const opened = JSON.parse((await cr(['open'])).out);
  await cr(['wait', '--timeout', '1', '--say', 'check the rounding first']);

  const { loadState } = await import('../../src/state/store.js');
  const session = (await loadState()).sessions[opened.key];

  assert.equal(session.note, 'check the rounding first');
  assert.deepEqual(session.comments, [], '--say must never create a comment');
});

test('reply and refresh drive a full round', async (t) => {
  const { cr, repo } = await setup(t);
  const opened = JSON.parse((await cr(['open'])).out);

  const { loadState } = await import('../../src/state/store.js');
  const { request } = await import('../../src/cli/client.js');
  const { readServerFile } = await import('../../src/server/index.js');
  const { port } = /** @type {{pid: number, port: number, version: string}} */ (await readServerFile());
  const { token } = (await loadState()).sessions[opened.key];

  await request(port, 'POST', `/api/sessions/${opened.key}/comments`, {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2,
    quote: 'TWO', body: 'rounding is wrong', verdict: 'fix',
  }, token);
  await request(port, 'POST', `/api/sessions/${opened.key}/send`, {}, token);

  const waited = JSON.parse((await cr(['wait', '--timeout', '5'])).out);
  assert.equal(waited.comments.length, 1);
  assert.equal(waited.comments[0].body, 'rounding is wrong');
  assert.equal(waited.comments[0].context.before.at(-1), 'one');

  const replied = await cr(['reply', '--id', '1', '--status', 'fixed', '--body', 'distributed the remainder']);
  assert.equal(replied.code, 0);

  await repo.write('a.js', 'one\nFIXED\nthree\n');
  const refreshed = JSON.parse((await cr(['refresh'])).out);
  assert.deepEqual(refreshed.stale, []);
});

test('reply exits 1 on a bad id or status', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  assert.equal((await cr(['reply', '--id', '9', '--status', 'fixed', '--body', 'x'])).code, 1);
  assert.equal((await cr(['reply', '--id', '1', '--status', 'nope', '--body', 'x'])).code, 1);
});

test('reply requires id, status and body', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['reply', '--id', '1']);
  assert.equal(result.code, 1);
  assert.match(result.out, /--status/);
});

test('close ends the session and a second close exits 1', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);

  const closed = await cr(['close']);
  assert.equal(closed.code, 0);
  assert.equal(JSON.parse(closed.out).closedBy, 'agent');

  assert.equal((await cr(['close'])).code, 1);
});

test('wait reports a session the human closed', async (t) => {
  const { cr } = await setup(t);
  const opened = JSON.parse((await cr(['open'])).out);

  const { loadState } = await import('../../src/state/store.js');
  const { request } = await import('../../src/cli/client.js');
  const { readServerFile } = await import('../../src/server/index.js');
  const { port } = /** @type {{pid: number, port: number, version: string}} */ (await readServerFile());
  const { token } = (await loadState()).sessions[opened.key];
  await request(port, 'POST', `/api/sessions/${opened.key}/close`, { closedBy: 'human' }, token);

  const json = JSON.parse((await cr(['wait', '--timeout', '1'])).out);
  assert.equal(json.closed, true);
  assert.equal(json.closedBy, 'human');
});

test('an unknown verb exits 1 with usage', async (t) => {
  const { cr } = await setup(t);
  const result = await cr(['frobnicate']);
  assert.equal(result.code, 1);
  assert.match(result.out, /usage: cr/);
});

test('help exits 0', async (t) => {
  const { cr } = await setup(t);
  assert.equal((await cr(['help'])).code, 0);
});
