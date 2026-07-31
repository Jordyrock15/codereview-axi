import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRepo } from '../helpers/repo.js';
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
  // Single-quoted even for a plain name: the suggestion must be safe to paste
  // regardless of what the PR head branch turns out to contain.
  assert.match(result.out, /git fetch origin 'feature-x' && git checkout 'feature-x'/);

  const after = {
    status: await repo.run(['status', '--porcelain']),
    head: await repo.run(['rev-parse', 'HEAD']),
    index: await repo.run(['diff', '--staged', '--stat']),
    stash: await repo.run(['stash', 'list']),
    reflog: await repo.run(['reflog']),
  };
  assert.deepEqual(after, before, '--pr must never fetch or check out');
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

test('list prints comments for the cwd session', async (t) => {
  const { cr } = await setup(t);
  await cr(['open']);
  const result = await cr(['list', '--json']);
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
  const result = await cr(['wait', '--timeout', '1', '--json']);

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

test('every slug the code can emit is documented in the README, and vice versa', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const documented = [...readme.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);

  assert.ok(documented.length > 0, 'README must have a slug table');
  assert.deepEqual([...ERROR_SLUGS].sort(), [...documented].sort());
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
