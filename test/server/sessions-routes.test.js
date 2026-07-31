import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';
import { buildSnapshot as realBuildSnapshot } from '../../src/diff/snapshot.js';

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

test('POST /api/sessions 422s a clean tree so the CLI can map it to a nothing-to-review error', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: '' });

  assert.equal(res.status, 422);
  assert.match(res.json.error, /nothing to review/);
});

test('POST /api/sessions with a base stores it and reports it', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', 'feature change']);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: 'n', base: 'main' });

  assert.equal(res.status, 201);
  assert.equal(res.json.base, 'main');
  assert.deepEqual(res.json.files.map((/** @type {{path: string}} */ f) => f.path), ['a.js']);

  const state = (await call('GET', `/api/sessions/${res.json.key}?t=${res.json.token}`)).json;
  assert.equal(state.base, 'main');
});

test('POST /api/sessions with a base that does not exist gives a legible 400, not a bare internal error', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: '', base: 'no-such-ref' });

  assert.equal(res.status, 400);
  assert.match(res.json.error, /no-such-ref/);
  assert.match(res.json.error, /fetch/i, 'a missing ref is the ordinary --pr failure: hint at fetching the base branch');
});

test('a missing base ref carrying shell metacharacters is quoted in the fetch hint, not interpolated raw', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  // Syntactically a valid ref (git ref names may contain ; | & `), so this
  // reaches the "could not resolve" branch rather than being refused
  // upfront; under --pr this base comes straight from gh, i.e. from whoever
  // opened the PR. The hint must still be safe to paste.
  const hostile = 'feat;curl-evil|sh';
  const res = await (await startApp(t)).call('POST', '/api/sessions', { repo: repo.dir, note: '', base: hostile });

  assert.equal(res.status, 400);
  assert.match(res.json.error, /fetch/i);
  assert.ok(
    res.json.error.includes(`git fetch origin '${hostile}'`),
    `expected the hint to single-quote the hostile ref, got: ${res.json.error}`,
  );
});

test('a base ref shaped like a flag is refused before it ever reaches git merge-base', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const res = await (await startApp(t)).call('POST', '/api/sessions', { repo: repo.dir, note: '', base: '--help' });

  assert.equal(res.status, 400);
  assert.match(res.json.error, /not a valid ref/);
});

test('POST /api/sessions with an unrelated-history base gives its own 400, distinct from a missing ref', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-q', '--orphan', 'unrelated']);
  await repo.write('b.js', 'other\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-qm', 'unrelated root']);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: '', base: 'main' });

  assert.equal(res.status, 400);
  assert.match(res.json.error, /common history/);
  assert.doesNotMatch(res.json.error, /fetch/i, 'unrelated histories are not a fetch problem');
});

// A 105MB diff in the wild hit MAX_BUFFER inside git() and surfaced as a bare
// `{"error":"internal error"}` 500. Reproduced for real: a file rewritten
// large enough that `git diff` alone overruns the buffer.
test('POST /api/sessions gives a legible 413 for a diff that overruns the buffer, not a bare 500', async (t) => {
  const { MAX_BUFFER } = await import('../../src/diff/git.js');
  const repo = await makeRepo({ 'big.txt': 'stub\n' });
  t.after(repo.cleanup);

  const target = MAX_BUFFER + (5 * 1024 * 1024);
  let out = '';
  let i = 0;
  while (out.length < target) { out += `line ${i} filler filler filler\n`; i += 1; }
  await repo.write('big.txt', out);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: '' });

  assert.equal(res.status, 413);
  assert.match(res.json.error, /buffer/i);
  assert.doesNotMatch(res.json.error, /^internal error$/, 'must name the reason, not the generic fallback');
});

test('a base session with no divergence says the branch has no changes, not that the working tree is clean', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-q', '-b', 'feature']);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: '', base: 'main' });

  assert.equal(res.status, 422);
  assert.match(res.json.error, /has no changes against main/);
  assert.doesNotMatch(res.json.error, /working tree is clean/);
});

test('a base session says the branch has no changes even while git status is genuinely dirty', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-q', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-qm', 'feature change']);
  // Revert in the worktree only: HEAD still carries the committed change, so
  // `git status` reports ` M a.js`, but the working tree now matches main
  // again, so the diff against the merge-base is empty. The earlier fix's
  // own test only covered zero divergence, where both the old and new
  // wording happen to be true; this is the case the finding was actually
  // about.
  await repo.write('a.js', 'one\n');

  const status = await repo.run(['status', '--porcelain']);
  assert.match(status, /^ M a\.js/m, 'the setup must produce a genuinely dirty working tree');

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: '', base: 'main' });

  assert.equal(res.status, 422);
  assert.match(res.json.error, /has no changes against main/);
  assert.doesNotMatch(res.json.error, /working tree is clean/);
});

test('refresh on a session whose base branch has since been deleted gives a legible 400', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-q', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-qm', 'feature change']);

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n', base: 'main' })).json;

  await repo.run(['branch', '-D', 'main']);
  const res = await call('POST', `/api/sessions/${key}/refresh?t=${token}`);

  assert.equal(res.status, 400);
  assert.match(res.json.error, /main/);
  assert.match(res.json.error, /fetch/i);
});

test('POST /api/sessions with a pr stores it alongside the base', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', 'feature change']);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', {
    repo: repo.dir, note: 'n', base: 'main', pr: 42,
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.pr, 42);

  const state = (await call('GET', `/api/sessions/${res.json.key}?t=${res.json.token}`)).json;
  assert.equal(state.pr, 42);
});

test('POST /api/sessions with a pr but no base is rejected, a PR session without a base is meaningless', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const { call } = await startApp(t);
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: 'n', pr: 42 });

  assert.equal(res.status, 400);
  assert.match(res.json.error, /base/);
});

test('a pr conflict names the incumbent PR, not just its base', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', 'feature change']);

  const { call } = await startApp(t);
  await call('POST', '/api/sessions', {
    repo: repo.dir, note: 'n', base: 'main', pr: 42,
  });

  const res = await call('POST', '/api/sessions', {
    repo: repo.dir, note: 'n', base: 'main', pr: 43,
  });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /PR 42/);
});

test('refresh with a stored base recomputes against the same merge base after a further commit', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', 'feature change']);

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n', base: 'main' })).json;

  await repo.write('b.js', 'new file\n');

  const res = await call('POST', `/api/sessions/${key}/refresh?t=${token}`);
  assert.equal(res.status, 200);

  const state = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;
  const paths = state.snapshot.files.map((/** @type {{path: string}} */ f) => f.path);
  assert.ok(paths.includes('a.js'), 'the committed change against the base must still be visible');
  assert.ok(paths.includes('b.js'), 'the new untracked change must also be visible');
});

test('a base conflict is refused with 409 even when the new base itself has nothing to review', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', 'feature change']);
  await repo.run(['checkout', '-b', 'develop']);

  const { call } = await startApp(t);
  await call('POST', '/api/sessions', { repo: repo.dir, note: 'n', base: 'main' });

  // develop is HEAD itself here, so a plain diff against it would be empty;
  // the base conflict must still win over a would-be 422.
  const res = await call('POST', '/api/sessions', { repo: repo.dir, note: 'n', base: 'develop' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /base/);
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

test('a new session defaults its view to unified', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  const res = await call('GET', `/api/sessions/${key}?t=${token}`);
  assert.equal(res.json.view, 'unified');
});

test('PATCH view rejects an unknown value', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  const res = await call('PATCH', `/api/sessions/${key}/view?t=${token}`, { view: 'sideways' });
  assert.equal(res.status, 400);
});

test('PATCH view accepts split and unified, and publishes view', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call, hub } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;

  /** @type {string[]} */
  const published = [];
  hub.publish = (k, event) => { published.push(event); return 1; };

  const split = await call('PATCH', `/api/sessions/${key}/view?t=${token}`, { view: 'split' });
  assert.equal(split.status, 200);
  assert.equal(split.json.view, 'split');
  assert.equal((await call('GET', `/api/sessions/${key}?t=${token}`)).json.view, 'split');

  const unified = await call('PATCH', `/api/sessions/${key}/view?t=${token}`, { view: 'unified' });
  assert.equal(unified.json.view, 'unified');
  assert.deepEqual(published, ['view', 'view']);
});

test('a reused session keeps its existing view rather than resetting to unified', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const first = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  await call('PATCH', `/api/sessions/${first.key}/view?t=${first.token}`, { view: 'split' });

  const second = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  assert.equal(second.reused, true);

  const state = (await call('GET', `/api/sessions/${second.key}?t=${second.token}`)).json;
  assert.equal(state.view, 'split');
});

test('PATCH view on a closed session is refused', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  await call('POST', `/api/sessions/${key}/close?t=${token}`, { closedBy: 'human' });

  const res = await call('PATCH', `/api/sessions/${key}/view?t=${token}`, { view: 'split' });
  assert.equal(res.status, 409);
});

test('a slow session create does not hold up an unrelated route behind the state mutex', async (t) => {
  const { call } = await startApp(t);

  // buildSnapshot does real work per untracked file (a stat, a readFile, a
  // binary sniff), all awaited in sequence; enough of them make it slow
  // enough to measure against. Before the fix this ran inside mutateState's
  // serialising queue, so nothing else could be served until it finished.
  const slow = await makeRepo({ 'seed.js': 'one\n' });
  t.after(slow.cleanup);
  for (let i = 0; i < 800; i += 1) await slow.write(`untracked-${i}.js`, `file number ${i}\n`);

  const other = await makeRepo({ 'a.js': 'one\n' });
  t.after(other.cleanup);
  await other.write('a.js', 'two\n');
  const opened = (await call('POST', '/api/sessions', { repo: other.dir, note: 'n' })).json;

  /** @type {string[]} */
  const order = [];
  const slowCreate = call('POST', '/api/sessions', { repo: slow.dir, note: 'n' })
    .then((res) => { order.push('slow-create'); return res; });

  // Give the slow create a head start comfortably past toplevel()'s own git
  // spawn (a few ms) and into buildSnapshot itself, so a serialised queue
  // would make quick-close wait behind the whole snapshot, not just the spawn.
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  const quickClose = call('POST', `/api/sessions/${opened.key}/close?t=${opened.token}`, { closedBy: 'agent' })
    .then((res) => { order.push('quick-close'); return res; });

  const [slowRes, closeRes] = await Promise.all([slowCreate, quickClose]);
  assert.equal(slowRes.status, 201);
  assert.equal(closeRes.status, 200);
  assert.deepEqual(order, ['quick-close', 'slow-create'], 'closing a different session must not wait behind a slow snapshot build');
});

test('a conflicting session wins over an empty-diff 422, deterministically rather than by timing', async (t) => {
  // Reproduces the interleaving the re-review found by chance at a 0-25ms
  // stagger: a working-diff open and a base:'main' open race for the same
  // repo, and the base one happens to have nothing to review. The commit
  // that revert-in-the-worktree gives us the same split as the motivating
  // case above: `git diff HEAD` (no base) is non-empty, `git diff
  // $(merge-base main HEAD)` is empty, and a plain diff-then-decide race
  // would let the empty one answer 422 first. buildSnapshot is injected so
  // the base request's own snapshot only resolves once the working-diff
  // request has already committed its session, which is a controllable
  // seam rather than a timing coincidence: whichever real-clock stagger
  // this runs under, the base request cannot get past its own buildSnapshot
  // until the ordering below says so.
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-q', '-b', 'feature']);
  await repo.write('a.js', 'two\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-qm', 'feature change']);
  await repo.write('a.js', 'one\n');

  /** @type {(value?: void) => void} */
  let releaseBaseBuild = () => {};
  const gate = new Promise((resolve) => { releaseBaseBuild = resolve; });

  /** @type {string[]} */
  const order = [];
  const buildSnapshot = async (/** @type {string} */ dir, /** @type {string|undefined} */ base) => {
    const built = await realBuildSnapshot(dir, base);
    if (base === 'main') { await gate; order.push('base-snapshot-released'); }
    return built;
  };

  const { call } = await startApp(t, { buildSnapshot });

  const basePromise = call('POST', '/api/sessions', { repo: repo.dir, note: 'n', base: 'main' });
  // A tick's head start biases the base request past its own fast conflict
  // pre-check (which runs before buildSnapshot and sees no session yet)
  // before the working-diff request below even starts; the gate above is
  // what actually guarantees the ordering that matters, not this.
  await new Promise((resolve) => { setImmediate(resolve); });

  const workingRes = await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' });
  assert.equal(workingRes.status, 201, 'the working-diff session must actually open');
  order.push('working-diff-committed');

  releaseBaseBuild();
  const baseRes = await basePromise;

  assert.deepEqual(order, ['working-diff-committed', 'base-snapshot-released']);
  assert.equal(baseRes.status, 409, 'a conflicting session must win over an empty-diff 422');
  assert.match(baseRes.json.error, /base/);
});
