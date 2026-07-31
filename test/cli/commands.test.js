import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRepo } from '../helpers/repo.js';
import { openSessionWithComments } from '../helpers/session.js';
import { USAGE, run, ERROR_SLUGS } from '../../src/cli/commands.js';

/**
 * Redirects CODEREVIEW_AXI_HOME to a throwaway directory for the test's
 * duration and kills any daemon it spawns, so `ensureServer` never touches
 * the developer's real `~/.codereview-axi`. Every test that reaches `run()`
 * with valid flags must call this: `ensureServer` runs before a handler gets
 * a chance to fail for its own reasons, so even a test aimed at some other
 * error still spawns a real daemon under whatever home is active.
 * @param {import('node:test').TestContext} t
 */
const isolateHome = async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  process.env.CODEREVIEW_AXI_HOME = home;

  const { readServerFile } = await import('../../src/server/index.js');
  const { shutdown } = await import('../../src/cli/client.js');

  // t.after runs hooks in registration order, so this must be registered
  // before the env deletion below or readServerFile looks in the wrong home.
  t.after(async () => {
    const info = await readServerFile();
    if (info) await shutdown(info.port, info.pid).catch(() => {});
  });

  t.after(() => { delete process.env.CODEREVIEW_AXI_HOME; });
};

/** @param {import('node:test').TestContext} t */
const setup = async (t) => {
  await isolateHome(t);
  const { run } = await import('../../src/cli/commands.js');

  const repo = await makeRepo({ 'a.js': 'one\ntwo\nthree\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\nTWO\nthree\n');

  /** @param {string[]} argv */
  const cr = (argv) => run({ argv: argv[0] === 'open' ? [...argv, '--no-browser'] : argv, cwd: repo.dir, env: process.env });
  return { cr, repo, run };
};

test('open prints session metadata as JSON and exits 0', async (t) => {
  const { cr } = await setup(t);
  const result = await cr(['open', '--note', 'changed a', '--json']);

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

  const bare = await cr(['open', '--json']);
  assert.equal(bare.code, 1, 'a bare open sees a clean tree relative to HEAD');
  assert.equal(JSON.parse(bare.out).error.code, 'nothing-to-review');

  const withBase = await cr(['open', '--base', 'main', '--json']);
  assert.equal(withBase.code, 0);
  const json = JSON.parse(withBase.out);
  assert.equal(json.base, 'main');
  assert.deepEqual(json.files.map((/** @type {{path: string}} */ f) => f.path), ['a.js']);
});

test('open --base with a ref that does not exist exits 1 with a legible message, not internal error', async (t) => {
  const { cr } = await setup(t);
  const result = await cr(['open', '--base', 'no-such-ref']);
  assert.equal(result.code, 1);
  assert.match(result.out, /no-such-ref/);
  assert.doesNotMatch(result.out, /internal error/);
});

test('open --base against unrelated histories exits 1 naming the real cause, not internal error', async (t) => {
  const { cr, repo } = await setup(t);
  await repo.run(['checkout', '-q', '--orphan', 'unrelated']);
  await repo.run(['rm', '-rf', '.']);
  await repo.write('b.js', 'other\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-qm', 'unrelated root']);

  const result = await cr(['open', '--base', 'main']);
  assert.equal(result.code, 1);
  assert.match(result.out, /common history/);
  assert.doesNotMatch(result.out, /internal error/);
});

test('refresh on a session whose base branch has since been deleted exits 1 with a legible message', async (t) => {
  const { cr, repo } = await setup(t);
  await repo.run(['checkout', '-q', '-b', 'feature']);
  await repo.write('a.js', 'branch change\ntwo\nthree\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-qm', 'feature change']);

  const opened = await cr(['open', '--base', 'main']);
  assert.equal(opened.code, 0);

  await repo.run(['branch', '-D', 'main']);
  const result = await cr(['refresh']);
  assert.equal(result.code, 1);
  assert.match(result.out, /main/);
  assert.doesNotMatch(result.out, /internal error/);
});

test('open --base with no value is a usage error, not a silent working-diff session', async (t) => {
  const { run, repo } = await setup(t);
  const result = await run({ argv: ['open', '--base', '--no-browser'], cwd: repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /--base/);
});

test('open --base= (an empty value) is a usage error', async (t) => {
  const { run, repo } = await setup(t);
  const result = await run({ argv: ['open', '--base=', '--no-browser'], cwd: repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /--base/);
});

test('open --pr N --base with no value is still refused as a combination error, not swallowed by base validation', async (t) => {
  const { run, repo } = await setup(t);
  const resolvePr = async () => { throw new Error('resolvePr must not be called when --pr and --base conflict'); };
  const result = await run({
    argv: ['open', '--pr', '5', '--base', '--no-browser'], cwd: repo.dir, resolvePr,
  });
  assert.equal(result.code, 1);
  assert.match(result.out, /--pr and --base cannot be combined/);
});

test('open --pr with --base is a usage error and never resolves the PR', async (t) => {
  const { run, repo } = await setup(t);
  const resolvePr = async () => { throw new Error('resolvePr must not be called when --pr and --base conflict'); };
  const result = await run({
    argv: ['open', '--pr', '5', '--base', 'main', '--no-browser'], cwd: repo.dir, resolvePr,
  });
  assert.equal(result.code, 1);
  assert.match(result.out, /--pr and --base cannot be combined/);
});

test('open --pr rejects a non-integer PR number without invoking gh', async (t) => {
  const { run, repo } = await setup(t);
  const resolvePr = async () => { throw new Error('resolvePr must not be called when --pr is not a valid number'); };
  const result = await run({
    argv: ['open', '--pr', 'abc', '--no-browser'], cwd: repo.dir, resolvePr,
  });
  assert.equal(result.code, 1);
  // The message is quoted inside a structured error payload now, so its own
  // quotes come back backslash-escaped rather than literal.
  assert.match(result.out, /--pr needs a positive whole number, got \\"abc\\"/);
});

test('open --pr with no value is a usage error without invoking gh', async (t) => {
  const { run, repo } = await setup(t);
  const resolvePr = async () => { throw new Error('resolvePr must not be called when --pr has no value'); };
  const result = await run({ argv: ['open', '--pr', '--no-browser'], cwd: repo.dir, resolvePr });
  assert.equal(result.code, 1);
  assert.match(result.out, /--pr needs a positive whole number, got true/);
});

test('open --pr exits 1 with a readable message when gh fails to resolve the PR', async (t) => {
  const { run, repo } = await setup(t);
  const resolvePr = async () => { throw new Error('gh could not resolve PR 9: not authenticated to github.com, or use --base instead'); };
  const result = await run({ argv: ['open', '--pr', '9', '--no-browser'], cwd: repo.dir, resolvePr });
  assert.equal(result.code, 1);
  assert.match(result.out, /not authenticated/);
});

test('open --pr on an unborn HEAD gives a legible message, not git\'s raw command-failed text', async (t) => {
  const { run } = await setup(t);
  const repo = await makeRepo();
  t.after(repo.cleanup);

  const resolvePr = async () => ({ base: 'main', head: 'feature-x' });
  const result = await run({
    argv: ['open', '--pr', '7', '--no-browser'], cwd: repo.dir, resolvePr,
  });

  assert.equal(result.code, 1);
  assert.match(result.out, /could not determine the current branch/);
  assert.doesNotMatch(result.out, /Command failed/);
});

test('open --pr refuses when the current branch is not the PR head, and touches no git state', async (t) => {
  const { run, repo } = await setup(t);
  const before = {
    status: await repo.run(['status', '--porcelain']),
    head: await repo.run(['rev-parse', 'HEAD']),
    index: await repo.run(['diff', '--staged', '--stat']),
    stash: await repo.run(['stash', 'list']),
    reflog: await repo.run(['reflog']),
  };

  const resolvePr = async () => ({ base: 'main', head: 'feature-x' });
  const result = await run({ argv: ['open', '--pr', '7', '--no-browser'], cwd: repo.dir, resolvePr });

  assert.equal(result.code, 1);
  assert.match(result.out, /feature-x/);
  // Single-quoted even for a plain name, and `--` before the ref on both
  // subcommands: the suggestion must be safe to paste regardless of what the
  // PR head branch turns out to contain.
  assert.match(result.out, /git fetch origin -- 'feature-x' && git switch -- 'feature-x'/);

  const after = {
    status: await repo.run(['status', '--porcelain']),
    head: await repo.run(['rev-parse', 'HEAD']),
    index: await repo.run(['diff', '--staged', '--stat']),
    stash: await repo.run(['stash', 'list']),
    reflog: await repo.run(['reflog']),
  };
  assert.deepEqual(after, before, '--pr must never fetch or check out');
});

test('open --pr refuses an option-shaped head branch rather than printing a command that would execute it', async (t) => {
  const { run, repo } = await setup(t);
  const resolvePr = async () => ({ base: 'main', head: '--upload-pack=/tmp/fake-upload-pack' });
  const result = await run({
    argv: ['open', '--pr', '7', '--no-browser', '--json'], cwd: repo.dir, resolvePr,
  });

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.out).error.code, 'invalid-input');
  assert.doesNotMatch(result.out, /git fetch/, 'an option-shaped head must never reach the suggested command');
});

test('open --pr refuses a short-option-shaped head branch the same way', async (t) => {
  const { run, repo } = await setup(t);
  const resolvePr = async () => ({ base: 'main', head: '-x' });
  const result = await run({ argv: ['open', '--pr', '7', '--no-browser', '--json'], cwd: repo.dir, resolvePr });

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.out).error.code, 'invalid-input');
});

test('open --pr 007 reports the normalised number, not the raw flag, in the refusal', async (t) => {
  const { run, repo } = await setup(t);
  const resolvePr = async () => ({ base: 'main', head: 'feature-x' });
  const result = await run({ argv: ['open', '--pr', '007', '--no-browser'], cwd: repo.dir, resolvePr });

  assert.equal(result.code, 1);
  assert.match(result.out, /PR 7 /);
  assert.doesNotMatch(result.out, /PR 007/);
});

test('open --pr succeeds on the PR head branch and records the pr on the session', async (t) => {
  const { run, repo } = await setup(t);
  await repo.run(['checkout', '-b', 'feature-x']);
  await repo.write('a.js', 'one\ncommitted change\nthree\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', 'branch change']);

  const resolvePr = async () => ({ base: 'main', head: 'feature-x' });
  const result = await run({ argv: ['open', '--pr', '11', '--no-browser'], cwd: repo.dir, resolvePr });

  assert.equal(result.code, 0);
  assert.match(result.out, /^base: main$/m);
  assert.match(result.out, /^pr: 11$/m);
});

test('open exits 1 with the nothing-to-review slug on a clean tree', async (t) => {
  const { cr, repo } = await setup(t);
  await repo.run(['checkout', '--', 'a.js']);
  const result = await cr(['open', '--json']);
  assert.equal(result.code, 1);
  assert.match(result.out, /nothing to review/);
  assert.equal(JSON.parse(result.out).error.code, 'nothing-to-review');
});

test('open exits 1 outside a git worktree', async (t) => {
  const { run } = await setup(t);
  const result = await run({ argv: ['open', '--no-browser'], cwd: tmpdir(), env: process.env });
  assert.equal(result.code, 1);
  assert.match(result.out, /not inside a git worktree/);
});

test('list states a definitive empty result for the cwd session, not a bare comment array', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['list', '--json']);
  assert.equal(result.code, 0);
  const json = JSON.parse(result.out);
  assert.match(json.empty, /no comments \(0 of 0\)/);
  assert.equal(json.comments, undefined, 'an empty array is not a definitive empty state');
});

test('a verb other than open exits 1 when no session exists for the cwd', async (t) => {
  const { cr } = await setup(t);
  const result = await cr(['list']);
  assert.equal(result.code, 1);
  assert.match(result.out, /no open session/);
});

test('wait states a definitive empty result on timeout, not a bare comment array', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['wait', '--timeout', '1', '--json']);

  assert.equal(result.code, 0);
  const json = JSON.parse(result.out);
  assert.match(json.empty, /no comments \(0 of 0\)/);
  assert.equal(json.comments, undefined, 'an empty array is not a definitive empty state');
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
  const opened = JSON.parse((await cr(['open', '--json'])).out);
  await cr(['wait', '--timeout', '1', '--say', 'check the rounding first']);

  const { loadState } = await import('../../src/state/store.js');
  const session = (await loadState()).sessions[opened.key];

  assert.equal(session.note, 'check the rounding first');
  assert.deepEqual(session.comments, [], '--say must never create a comment');
});

test('reply and refresh drive a full round', async (t) => {
  const { cr, repo } = await setup(t);
  const opened = JSON.parse((await cr(['open', '--json'])).out);

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

  const waited = JSON.parse((await cr(['wait', '--timeout', '5', '--json'])).out);
  assert.equal(waited.comments.length, 1);
  assert.equal(waited.comments[0].body, 'rounding is wrong');
  assert.equal(waited.comments[0].context, undefined, 'context is CLI-only noise, dropped before printing');
  assert.equal(waited.counts.total, 1);
  assert.equal(waited.counts.sent, 1);

  const replied = await cr(['reply', '--id', '1', '--status', 'fixed', '--body', 'distributed the remainder']);
  assert.equal(replied.code, 0);
  // The failure this prevents: routing reply through the full field set, so
  // the body the agent just wrote (and its quote, and timestamps) come back
  // to it for no reason.
  assert.match(replied.out, /^id: 1$/m);
  assert.match(replied.out, /^status: answered$/m);
  assert.match(replied.out, /^counts:$/m);
  assert.match(replied.out, /^\s+total: 1$/m);
  assert.doesNotMatch(replied.out, /distributed the remainder/);
  assert.doesNotMatch(replied.out, /rounding is wrong/);
  assert.doesNotMatch(replied.out, /quote/);

  await repo.write('a.js', 'one\nFIXED\nthree\n');
  const refreshed = JSON.parse((await cr(['refresh', '--json'])).out);
  assert.deepEqual(refreshed.stale, []);
});

test('reply exits 1 with not-found on an unknown id, invalid-input on a bad status value', async (t) => {
  const { cr } = await setup(t);
  const opened = JSON.parse((await cr(['open', '--json'])).out);

  const unknownId = await cr(['reply', '--id', '9', '--status', 'fixed', '--body', 'x']);
  assert.equal(unknownId.code, 1);
  assert.match(unknownId.out, /code: not-found/);

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

  const badStatus = await cr(['reply', '--id', '1', '--status', 'nope', '--body', 'x']);
  assert.equal(badStatus.code, 1);
  assert.match(badStatus.out, /code: invalid-input/);
});

test('refresh on a closed session exits 1 with the session-closed slug', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  await cr(['close']);

  const result = await cr(['refresh']);
  assert.equal(result.code, 1);
  assert.match(result.out, /code: session-closed/);
});

test('wait exits 1 with the agent-waiting slug when another pid already holds the poll', async (t) => {
  const { cr } = await setup(t);
  const opened = JSON.parse((await cr(['open', '--json'])).out);

  const { loadState } = await import('../../src/state/store.js');
  const { request } = await import('../../src/cli/client.js');
  const { readServerFile } = await import('../../src/server/index.js');
  const { port } = /** @type {{pid: number, port: number, version: string}} */ (await readServerFile());
  const { token } = (await loadState()).sessions[opened.key];

  const held = request(port, 'GET', `/api/sessions/${opened.key}/pending?holder=999111&timeout=5`, undefined, token);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const result = await cr(['wait', '--timeout', '1']);
  assert.equal(result.code, 1);
  assert.match(result.out, /code: agent-waiting/);

  await request(port, 'POST', `/api/sessions/${opened.key}/send`, {}, token);
  await held;
});

test('reply requires id, status and body', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['reply', '--id', '1']);
  assert.equal(result.code, 1);
  assert.match(result.out, /--status/);
});

test('reply --body with no value is refused, same as omitting it, not swallowed as an empty body', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['reply', '--id', '1', '--status', 'fixed', '--body']);
  assert.equal(result.code, 1);
  assert.match(result.out, /--body/);
});

test('list --status with no value is a usage error, not "no filter"', async (t) => {
  const s = await openSessionWithComments(t, [
    { body: 'one', verdict: 'fix' },
    { body: 'two', verdict: 'fix' },
  ]);

  const result = await run({ argv: ['list', '--status'], cwd: s.repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /--status needs a value/);
});

test('list --fields with no value is a usage error, not the default field set', async (t) => {
  const s = await openSessionWithComments(t, [{ body: 'one', verdict: 'fix' }]);
  const result = await run({ argv: ['list', '--fields'], cwd: s.repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /--fields needs a value/);
});

test('wait --say with no value is a usage error, not a silently skipped note update', async (t) => {
  const s = await openSessionWithComments(t, []);
  const result = await run({ argv: ['wait', '--timeout', '1', '--say'], cwd: s.repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /--say needs a value/);
});

test('open --note with no value is a usage error, not a silently empty note', async (t) => {
  const { run, repo } = await setup(t);
  const result = await run({ argv: ['open', '--no-browser', '--note'], cwd: repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /--note needs a value/);
});

test('wait --timeout with no value is a usage error, not a silent 1-second poll', async (t) => {
  const s = await openSessionWithComments(t, []);
  const result = await run({ argv: ['wait', '--timeout'], cwd: s.repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /--timeout needs a value/);
});

test('wait --timeout abc is refused rather than turning into a hot loop against the server', async (t) => {
  const s = await openSessionWithComments(t, []);
  const started = Date.now();
  const result = await run({ argv: ['wait', '--timeout', 'abc'], cwd: s.repo.dir });
  const elapsed = Date.now() - started;

  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /--timeout must be a positive number/);
  // The failure this prevents: NaN reaching setTimeout, which fires
  // immediately, so a bug here would return in well under a second even
  // though nothing was ever posted for the poll to catch.
  assert.equal(elapsed < 5000, true);
});

test('wait --timeout 0 and a negative timeout are both refused as non-positive', async (t) => {
  const s = await openSessionWithComments(t, []);
  const zero = await run({ argv: ['wait', '--timeout', '0'], cwd: s.repo.dir });
  assert.equal(zero.code, 1);
  assert.match(zero.out, /--timeout must be a positive number/);

  const negative = await run({ argv: ['wait', '--timeout', '-5'], cwd: s.repo.dir });
  assert.equal(negative.code, 1);
  assert.match(negative.out, /--timeout must be a positive number/);
});

test('close ends the session and a second close exits 1', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);

  const closed = await cr(['close', '--json']);
  assert.equal(closed.code, 0);
  assert.equal(JSON.parse(closed.out).closedBy, 'agent');

  assert.equal((await cr(['close'])).code, 1);
});

test('wait reports a session the human closed', async (t) => {
  const { cr } = await setup(t);
  const opened = JSON.parse((await cr(['open', '--json'])).out);

  const { loadState } = await import('../../src/state/store.js');
  const { request } = await import('../../src/cli/client.js');
  const { readServerFile } = await import('../../src/server/index.js');
  const { port } = /** @type {{pid: number, port: number, version: string}} */ (await readServerFile());
  const { token } = (await loadState()).sessions[opened.key];
  await request(port, 'POST', `/api/sessions/${opened.key}/close`, { closedBy: 'human' }, token);

  const json = JSON.parse((await cr(['wait', '--timeout', '1', '--json'])).out);
  assert.equal(json.closed, true);
  assert.equal(json.closedBy, 'human');
});

test('an unknown verb exits 1 as a structured error, parseable under --json', async (t) => {
  const { cr } = await setup(t);
  const result = await cr(['frobnicate']);
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);

  const json = await cr(['frobnicate', '--json']);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.out).error.code, 'usage');
});

test('a verb named after an Object.prototype member is an unknown verb, not a crash', async (t) => {
  const { cr } = await setup(t);
  for (const verb of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const result = await cr([verb, '--json']);
    assert.equal(result.code, 1, `"${verb}" must be refused cleanly`);
    assert.equal(JSON.parse(result.out).error.code, 'usage');
  }
});

test('help exits 0', async (t) => {
  const { cr } = await setup(t);
  assert.equal((await cr(['help'])).code, 0);
});

test('--json=true is a usage error, not a silent TOON response the agent will fail to parse', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  // The failure this prevents: flags.json === true never matches the string
  // 'true', so the code path fell through to TOON while the agent, having
  // asked for --json, tries JSON.parse on it and blows up.
  const result = await cr(['list', '--json=true']);
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /--json/);
});

test('--no-browser=false is a usage error, not a silently-opened tab', async (t) => {
  const { run, repo } = await setup(t);
  const result = await run({ argv: ['open', '--no-browser=false'], cwd: repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /--no-browser/);
});

test('--no-browser main is a usage error: the stray token is rejected, not swallowed as the flag\'s value', async (t) => {
  const { run, repo } = await setup(t);
  const result = await run({ argv: ['open', '--no-browser', 'main'], cwd: repo.dir });
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /main/);
});

test("the README's usage block matches USAGE exactly, not by eye", async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const fence = readme.match(/```\nusage: cr <verb> \[flags\]\n([\s\S]*?)```/);
  assert.ok(fence, "README must have a fenced 'usage: cr <verb> [flags]' block");

  const readmeBlock = `usage: cr <verb> [flags]\n${fence[1]}`.replace(/\n$/, '');
  // The exit-codes line lives in the README's own "## Exit codes" table
  // instead, so the fenced block is USAGE minus its trailing blank line and
  // that one line.
  const verbsOnly = USAGE.split('\n').slice(0, -2).join('\n');

  assert.equal(readmeBlock, verbsOnly);
});

/**
 * Every slug the source can actually produce, read out of the code itself
 * rather than a second hand-written list: a new slug added to a `throw` and
 * forgotten in `ERROR_SLUGS` must fail this, which a hand-written comparison
 * cannot.
 * @returns {Promise<Set<string>>}
 */
const slugsInSource = async () => {
  const commands = await readFile(new URL('../../src/cli/commands.js', import.meta.url), 'utf8');
  const client = await readFile(new URL('../../src/cli/client.js', import.meta.url), 'utf8');
  const slugs = new Set();

  // Every `new CliError(code, message, slug)` call, wherever it sits (bare,
  // inside `fail(...)`, inside a ternary): capture up to the statement's
  // trailing semicolon, then read the last quoted literal off the tail.
  for (const src of [commands, client]) {
    for (const m of src.matchAll(/new CliError\(([\s\S]*?)\);/g)) {
      const literal = m[1].match(/'([a-z][a-z-]*)'\s*\)*\s*$/);
      if (literal) slugs.add(literal[1]);
    }
  }

  // slugForStatus's own return statements are the one case where a CliError
  // call site passes a function result rather than a literal.
  const fn = commands.match(/const slugForStatus = [\s\S]*?\n};/);
  assert.ok(fn, 'slugForStatus must exist in commands.js for this test to read its slugs');
  for (const m of fn[0].matchAll(/return '([a-z][a-z-]*)'/g)) slugs.add(m[1]);

  // The catch-all in run() for a throw that never went through CliError.
  const fallback = commands.match(/err\.slug : '([a-z][a-z-]*)'/);
  assert.ok(fallback, 'run() must have a named fallback slug for a non-CliError throw');
  slugs.add(fallback[1]);

  return slugs;
};

test('every slug the code can emit is documented in the README, and vice versa', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const documented = [...readme.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);

  assert.ok(documented.length > 0, 'README must have a slug table');
  assert.deepEqual([...ERROR_SLUGS].sort(), [...documented].sort());
});

test('ERROR_SLUGS is derived from what the source can actually throw, not a parallel hand-written list', async () => {
  const fromSource = await slugsInSource();
  assert.ok(fromSource.size > 0, 'the source scan must find at least one slug, or it is not scanning');
  assert.deepEqual([...ERROR_SLUGS].sort(), [...fromSource].sort());
});

test('an unrecognised flag is refused rather than silently ignored', async (t) => {
  // This exits before ensureServer today, so it never touches the real home,
  // but isolating it means a future regression that made it fall through
  // fails loudly here rather than quietly spawning a real daemon.
  await isolateHome(t);
  const result = await run({ argv: ['open', '--nonsense-flag', '--no-browser'], cwd: process.cwd() });
  assert.equal(result.code, 2);
  assert.match(result.out, /unknown flag --nonsense-flag/);
});

test('an unrecognised flag does not open a session', async (t) => {
  // The failure this prevents: exit 0 and a session against the wrong surface.
  // Under TOON a session's key prints as `key: ...` with no quotes, so this
  // must match the TOON form rather than a JSON-shaped one that can never fail.
  await isolateHome(t);
  const result = await run({ argv: ['open', '--bse', 'main', '--no-browser'], cwd: process.cwd() });
  assert.equal(result.code, 2);
  assert.equal(/^key: /m.test(result.out), false, 'no session metadata may be printed');
});

test('--help on a verb describes only that verb', async (t) => {
  await isolateHome(t);
  const result = await run({ argv: ['reply', '--help'], cwd: process.cwd() });
  assert.equal(result.code, 0);
  assert.match(result.out, /usage: cr reply/);
  assert.equal(/--no-browser/.test(result.out), false);
});

test('open prints TOON by default and JSON under --json', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const toon = await run({ argv: ['open', '--no-browser'], cwd: repo.dir });
  assert.equal(toon.code, 0);
  assert.match(toon.out, /^key: /m, 'a TOON field line');
  assert.equal(toon.out.trimStart().startsWith('{'), false, 'not JSON');

  const json = await run({ argv: ['open', '--json', '--no-browser'], cwd: repo.dir });
  assert.equal(json.code, 0);
  assert.doesNotThrow(() => JSON.parse(json.out));
});

test('an error is a structured TOON error object carrying the prose', async (t) => {
  await isolateHome(t);
  const result = await run({ argv: ['open', '--base=', '--no-browser'], cwd: process.cwd() });
  assert.equal(result.code, 1);
  assert.match(result.out, /^error:/m);
  assert.match(result.out, /code: /);
  assert.match(result.out, /--base needs a value/);
});

test('a clean tree is exit 1 with the nothing-to-review slug, not a bare exit code', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const result = await run({ argv: ['open', '--json', '--no-browser'], cwd: repo.dir });
  assert.equal(result.code, 1, 'axi reserves 2 for an unknown flag');
  assert.equal(JSON.parse(result.out).error.code, 'nothing-to-review');
});

test('an unknown flag and a clean tree are told apart by exit code, not by prose', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const clean = await run({ argv: ['open', '--no-browser'], cwd: repo.dir });
  const bogus = await run({ argv: ['open', '--nope', '--no-browser'], cwd: repo.dir });
  assert.equal(clean.code, 1);
  assert.equal(bogus.code, 2);
});

test('an error under --json is parseable and keeps the same code and message', async (t) => {
  await isolateHome(t);
  const result = await run({ argv: ['open', '--base=', '--json', '--no-browser'], cwd: process.cwd() });
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.out);
  assert.equal(typeof parsed.error.code, 'string');
  assert.match(parsed.error.message, /--base needs a value/);
});

test('usage output stays plain text under both formats', async (t) => {
  await isolateHome(t);
  for (const argv of [['reply', '--help'], ['reply', '--help', '--json']]) {
    const result = await run({ argv, cwd: process.cwd() });
    assert.match(result.out, /usage: cr reply/);
  }
});

test("every verb's real success payload encodes as TOON without throwing", async (t) => {
  const { cr, repo } = await setup(t);
  const { encode } = await import('../../src/cli/toon.js');
  const { loadState } = await import('../../src/state/store.js');
  const { request } = await import('../../src/cli/client.js');
  const { readServerFile } = await import('../../src/server/index.js');

  // `--json` gives a parseable handle on the same value `encode()` sees on
  // the default path: both formats run through the same presentation-layer
  // reshape (see `forDisplay` in commands.js) before either is applied. This
  // is a shape check, not a golden-output test, so it survives fields moving.
  const opened = JSON.parse((await cr(['open', '--json'])).out);
  assert.doesNotThrow(() => encode(opened), 'open');

  const { port } = /** @type {{pid: number, port: number, version: string}} */ (await readServerFile());
  const { token } = (await loadState()).sessions[opened.key];
  await request(port, 'POST', `/api/sessions/${opened.key}/comments`, {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2,
    quote: 'TWO', body: 'rounding is wrong', verdict: 'fix',
  }, token);
  await request(port, 'POST', `/api/sessions/${opened.key}/send`, {}, token);

  const waited = JSON.parse((await cr(['wait', '--timeout', '5', '--json'])).out);
  assert.doesNotThrow(() => encode(waited), 'wait');

  const listed = JSON.parse((await cr(['list', '--json'])).out);
  assert.doesNotThrow(() => encode(listed), 'list');

  const replied = JSON.parse((await cr(['reply', '--id', '1', '--status', 'fixed', '--body', 'x', '--json'])).out);
  assert.doesNotThrow(() => encode(replied), 'reply');

  await repo.write('a.js', 'one\nFIXED\nthree\n');
  const refreshed = JSON.parse((await cr(['refresh', '--json'])).out);
  assert.doesNotThrow(() => encode(refreshed), 'refresh');

  const closed = JSON.parse((await cr(['close', '--json'])).out);
  assert.doesNotThrow(() => encode(closed), 'close');
});

test('an empty --fields selection is a usage error on list, not a silently empty comment object', async (t) => {
  const s = await openSessionWithComments(t, [{ body: 'one', verdict: 'fix' }]);

  for (const value of ['', ' ', ',']) {
    const result = await run({ argv: ['list', `--fields=${value}`], cwd: s.repo.dir });
    assert.equal(result.code, 1, `--fields=${JSON.stringify(value)} must be refused`);
    assert.match(result.out, /code: usage/);
  }

  // The worst outcome named in the finding: exit 0 with a comments array of
  // empty objects, silently telling the agent it succeeded and got nothing.
  const json = await run({ argv: ['list', '--fields=', '--json'], cwd: s.repo.dir });
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.out).error.code, 'usage');
});

test('an empty --fields selection is a usage error on wait too', async (t) => {
  const s = await openSessionWithComments(t, [{ body: 'one', verdict: 'fix' }]);

  for (const value of ['', ' ', ',']) {
    const result = await run({ argv: ['wait', '--timeout', '1', `--fields=${value}`], cwd: s.repo.dir });
    assert.equal(result.code, 1, `--fields=${JSON.stringify(value)} must be refused`);
    assert.match(result.out, /code: usage/);
  }
});

test('list reports counts over the unfiltered set, so a filter shows what it excluded', async (t) => {
  const s = await openSessionWithComments(t, [
    { body: 'one', verdict: 'fix' },
    { body: 'two', verdict: 'fix' },
  ]);

  const result = await run({ argv: ['list', '--json'], cwd: s.repo.dir });
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.counts.total, 2);
  assert.equal(parsed.counts.open, 2);
});

test('an empty result states so and names the filter and the total', async (t) => {
  const s = await openSessionWithComments(t, [{ body: 'one', verdict: 'fix' }]);

  const result = await run({ argv: ['list', '--status', 'answered'], cwd: s.repo.dir });
  assert.equal(result.code, 0);
  assert.match(result.out, /no comments \(0 of 1 match status=answered\)/);
});

test('an empty result with no comments at all still states so, never bare output', async (t) => {
  const s = await openSessionWithComments(t, []);

  const result = await run({ argv: ['list'], cwd: s.repo.dir });
  assert.equal(result.code, 0);
  assert.match(result.out, /no comments \(0 of 0\)/);
  assert.equal(/comments: \[\]/.test(result.out), false, 'an empty array is not a definitive empty state');
});

test('help[] lines are appended by default and suppressed by --no-help', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const withHelp = await run({ argv: ['open', '--no-browser'], cwd: repo.dir });
  assert.match(withHelp.out, /^help\[\d+\]: /m);

  const without = await run({ argv: ['open', '--no-browser', '--no-help'], cwd: repo.dir });
  assert.equal(/^help\[/m.test(without.out), false);
});

test('--json output is parseable with help[] present', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  const result = await run({ argv: ['open', '--json', '--no-browser'], cwd: repo.dir });
  const parsed = JSON.parse(result.out);
  assert.equal(Array.isArray(parsed.help), true);
});

test('bare cr inside a repo with a session shows live state, not usage', async (t) => {
  const s = await openSessionWithComments(t, [{ body: 'one', verdict: 'fix' }]);

  const result = await run({ argv: [], cwd: s.repo.dir });
  assert.equal(result.code, 0);
  assert.equal(/^usage: cr/.test(result.out), false, 'usage is the fallback, not the answer');
  assert.match(result.out, /unsent: 1|open: 1/);
});

test('bare cr outside a git worktree falls back to usage', async () => {
  const result = await run({ argv: [], cwd: tmpdir() });
  assert.equal(result.code, 0);
  assert.match(result.out, /^usage: cr/);
});

test('bare cr in a repo with no session falls back to usage', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const result = await run({ argv: [], cwd: repo.dir });
  assert.equal(result.code, 0);
  assert.match(result.out, /^usage: cr/);
});

test('bare cr does not start the server daemon', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  await run({ argv: [], cwd: repo.dir });
  // No server.json is written, because ensureServer was never called.
  await assert.rejects(() => readFile(path.join(String(process.env.CODEREVIEW_AXI_HOME), 'server.json')));
});

test('setup writes into the repo by default, and never touches the injected homedir', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const fakeHome = await mkdtemp(path.join(tmpdir(), 'cr-fakehome-'));
  const result = await run({
    argv: ['setup'], cwd: repo.dir, homedir: () => fakeHome,
  });

  assert.equal(result.code, 0);
  assert.match(result.out, /action: added/);
  // The resolved path is part of the payload, so this is the seam itself
  // speaking: without --global it must resolve inside the repo, never
  // through the injected homedir.
  const realRepoDir = await realpath(repo.dir);
  assert.match(result.out, new RegExp(`path: ${path.join(realRepoDir, '.claude', 'settings.local.json')}`));

  const written = JSON.parse(await readFile(path.join(repo.dir, '.claude', 'settings.local.json'), 'utf8'));
  // The installed command is an absolute interpreter plus script path, not a
  // bare `cr` resolved through PATH at session-start time: see Important 3.
  assert.match(written.hooks.SessionStart[0].hooks[0].command, /bin\/cr\.js/);
  assert.doesNotMatch(written.hooks.SessionStart[0].hooks[0].command, /^cr$/);
  await assert.rejects(() => readFile(path.join(fakeHome, '.claude', 'settings.json')), 'homedir must be untouched by the non-global branch');
});

test('setup --global writes into the injected homedir, never the real one', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const fakeHome = await mkdtemp(path.join(tmpdir(), 'cr-fakehome-'));
  const result = await run({
    argv: ['setup', '--global'], cwd: repo.dir, homedir: () => fakeHome,
  });

  assert.equal(result.code, 0);
  assert.match(result.out, /action: added/);
  // Same seam, the other arm: --global must resolve through the injected
  // homedir, and the injected function is the only thing that can prove it,
  // since nothing here ever calls the real os.homedir().
  // Unlike repo.dir (resolved by git's `toplevel`), fakeHome is passed
  // straight through path.join with no symlink resolution, so the raw value
  // is what the payload must contain.
  assert.match(result.out, new RegExp(`path: ${path.join(fakeHome, '.claude', 'settings.json')}`));

  const written = JSON.parse(await readFile(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  assert.match(written.hooks.SessionStart[0].hooks[0].command, /bin\/cr\.js/);
  await assert.rejects(
    () => readFile(path.join(repo.dir, '.claude', 'settings.local.json')),
    'the global branch must not also write the repo-local file',
  );
});

test('setup installs a marked hook and a second run recognises it even if an unrelated hook already uses the command text', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  const first = await run({ argv: ['setup'], cwd: repo.dir });
  assert.match(first.out, /action: added/);
  const settingsPath = path.join(repo.dir, '.claude', 'settings.local.json');
  const afterFirst = await readFile(settingsPath, 'utf8');

  const second = await run({ argv: ['setup'], cwd: repo.dir });
  assert.match(second.out, /action: already-present/);
  assert.equal(await readFile(settingsPath, 'utf8'), afterFirst, 'a second run must not rewrite the file');
});

test('setup writes the settings file at mode 0600, not the default 0644', async (t) => {
  await isolateHome(t);
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);

  await run({ argv: ['setup'], cwd: repo.dir });
  const settingsPath = path.join(repo.dir, '.claude', 'settings.local.json');
  const { stat } = await import('node:fs/promises');
  const mode = (await stat(settingsPath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('bare cr with an unknown flag is refused, not treated as a status glance', async (t) => {
  await isolateHome(t);
  const result = await run({ argv: ['--bogus'], cwd: tmpdir() });
  assert.equal(result.code, 2);
  assert.match(result.out, /unknown flag --bogus/);
});

test('bare cr --json=true is a usage error, not a silent TOON fallback', async (t) => {
  await isolateHome(t);
  const result = await run({ argv: ['--json=true'], cwd: tmpdir() });
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /--json/);
});

test('bare cr --no-help suppresses help[] on live state, routed through the same suppression as every verb', async (t) => {
  const s = await openSessionWithComments(t, [{ body: 'one', verdict: 'fix' }]);

  const withHelp = await run({ argv: [], cwd: s.repo.dir });
  assert.match(withHelp.out, /^help\[\d+\]: /m);

  const without = await run({ argv: ['--no-help'], cwd: s.repo.dir });
  assert.equal(/^help\[/m.test(without.out), false);
});

test('bare cr with --json gives live state as JSON, usage fallback stays plain text', async (t) => {
  const s = await openSessionWithComments(t, [{ body: 'one', verdict: 'fix' }]);

  const live = await run({ argv: ['--json'], cwd: s.repo.dir });
  assert.equal(live.code, 0);
  const parsed = JSON.parse(live.out);
  assert.equal(parsed.unsent, 1);

  const fallback = await run({ argv: ['--json'], cwd: tmpdir() });
  assert.equal(fallback.code, 0);
  assert.match(fallback.out, /^usage: cr/);
});
