import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from '../helpers/repo.js';

const exec = promisify(execFile);
// `URL.pathname` percent-encodes, so a directory containing a space would
// make BIN a path that does not exist on disk.
const BIN = fileURLToPath(new URL('../../bin/cr.js', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Every `cr` call except `help` and an unknown verb spawns a real detached
 * daemon via `ensureServer` before its handler even runs. Left alone it
 * outlives the test, so teardown has to reach it directly by pid over
 * `/api/shutdown`, the same route the CLI itself uses to retire a stale server.
 * @param {NodeJS.ProcessEnv} env
 */
const killDaemon = async (env) => {
  try {
    const { readFile } = await import('node:fs/promises');
    const { pid, port } = JSON.parse(await readFile(path.join(/** @type {string} */ (env.CODEREVIEW_AXI_HOME), 'server.json'), 'utf8'));
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  } catch {
    // no server.json: nothing was ever spawned for this home
  }
};

/**
 * @param {import('node:test').TestContext} t
 */
const setup = async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  const repo = await makeRepo({ 'a.js': 'one\ntwo\nthree\nfour\nfive\n' });

  const env = { ...process.env, CODEREVIEW_AXI_HOME: home };

  /** @param {string[]} args */
  const cr = async (args) => {
    try {
      const withFlags = args[0] === 'open' ? [...args, '--no-browser'] : args;
      const { stdout } = await exec(process.execPath, [BIN, ...withFlags], { cwd: repo.dir, env });
      return { code: 0, out: stdout };
    } catch (err) {
      const failure = /** @type {import('node:child_process').ExecFileException & {stdout?: string, stderr?: string}} */ (err);
      return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  };

  // Registration order is run order: shutdown must fire before repo.cleanup,
  // since cr(['close']) needs repo.dir to still exist as its cwd.
  t.after(async () => {
    await cr(['close']);
    await killDaemon(env);
  });
  t.after(repo.cleanup);

  await repo.write('a.js', 'one\nTWO\nthree\nfour\nfive\n');
  return { cr, repo, env, home };
};

/**
 * Reads the session token straight from state, the way the CLI does.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 */
const tokenFor = async (env, key) => {
  const { readFile } = await import('node:fs/promises');
  const state = JSON.parse(await readFile(path.join(/** @type {string} */ (env.CODEREVIEW_AXI_HOME), 'state.json'), 'utf8'));
  return state.sessions[key].token;
};

/**
 * @param {number} port
 * @param {string} key
 * @param {string} token
 * @param {string} path_
 * @param {unknown} [body]
 */
const post = async (port, key, token, path_, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${key}${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cr-token': token },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** @param {NodeJS.ProcessEnv} env */
const portFor = async (env) => {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(path.join(/** @type {string} */ (env.CODEREVIEW_AXI_HOME), 'server.json'), 'utf8')).port;
};

test('a full session runs open, comment, send, wait, reply, refresh, follow-up, close', async (t) => {
  const { cr, repo, env } = await setup(t);

  const opened = JSON.parse((await cr(['open', '--note', 'refactored a', '--json'])).out);
  assert.equal(opened.reused, false);

  const port = await portFor(env);
  const token = await tokenFor(env, opened.key);

  // The human comments and sends.
  const created = await post(port, opened.key, token, '/comments', {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2,
    quote: 'TWO', body: 'rounding is wrong', verdict: 'fix',
  });
  assert.equal(created.status, 201);
  assert.equal((await post(port, opened.key, token, '/send')).json.sent, 1);

  // The agent collects. Context is computed by the route (see
  // test/server/pending.test.js) but dropped from the CLI's own output.
  // --fields all is needed here to see status at all: it sits outside the
  // minimal default set (see src/cli/present.js).
  const waited = JSON.parse((await cr(['wait', '--timeout', '5', '--json', '--fields', 'all'])).out);
  assert.equal(waited.comments.length, 1);
  assert.equal(waited.comments[0].status, 'sent');
  assert.equal(waited.comments[0].context, undefined, 'context is CLI-only noise, dropped before printing');

  // The agent fixes and replies.
  await repo.write('a.js', 'one\nFIXED\nthree\nfour\nfive\n');
  assert.equal((await cr(['reply', '--id', '1', '--status', 'fixed', '--body', 'distributed'])).code, 0);

  const refreshed = JSON.parse((await cr(['refresh', '--json'])).out);
  assert.deepEqual(refreshed.stale, [], 'an answered thread never goes stale, even though its quote is gone');

  const listed = JSON.parse((await cr(['list', '--json', '--fields', 'all'])).out);
  assert.equal(listed.comments[0].status, 'answered');

  // The human follows up with new text rather than reopening the same body.
  await fetch(`http://127.0.0.1:${port}/api/sessions/${opened.key}/comments/1/followup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cr-token': token },
    body: JSON.stringify({ body: 'also check the negative case' }),
  });
  assert.equal((await post(port, opened.key, token, '/send')).json.sent, 1);
  const followedUp = JSON.parse((await cr(['wait', '--timeout', '5', '--json'])).out);
  assert.equal(followedUp.comments.length, 1);
  assert.equal(followedUp.comments[0].body, 'also check the negative case', 'the agent gets the follow-up text, not the original body');

  // The human ends it.
  await post(port, opened.key, token, '/close', { closedBy: 'human' });
  const final = JSON.parse((await cr(['wait', '--timeout', '2', '--json'])).out);
  assert.equal(final.closed, true);
  assert.equal(final.closedBy, 'human');
});

test('the repository is byte-identical after a full session', async (t) => {
  const { cr, repo, env } = await setup(t);

  const before = {
    status: await repo.run(['status', '--porcelain=v1', '-z']),
    head: await repo.run(['rev-parse', 'HEAD']),
    index: await repo.run(['diff', '--staged', '--stat']),
    stash: await repo.run(['stash', 'list']),
    reflog: await repo.run(['reflog', '--format=%H %gs']),
  };

  const opened = JSON.parse((await cr(['open', '--note', 'n', '--json'])).out);
  const port = await portFor(env);
  const token = await tokenFor(env, opened.key);

  await post(port, opened.key, token, '/comments', {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2,
    quote: 'TWO', body: 'x', verdict: 'fix',
  });
  await post(port, opened.key, token, '/send');
  await cr(['wait', '--timeout', '5']);
  await cr(['reply', '--id', '1', '--status', 'skipped', '--body', 'leaving as is']);
  await cr(['refresh']);
  await cr(['close']);

  const after = {
    status: await repo.run(['status', '--porcelain=v1', '-z']),
    head: await repo.run(['rev-parse', 'HEAD']),
    index: await repo.run(['diff', '--staged', '--stat']),
    stash: await repo.run(['stash', 'list']),
    reflog: await repo.run(['reflog', '--format=%H %gs']),
  };

  assert.deepEqual(after, before, 'cr must never write to the repository under review');
});

test('the repository is byte-identical after a --base session, a refresh, and the base branch disappearing mid-session', async (t) => {
  const { cr, repo, env } = await setup(t);
  await repo.run(['checkout', '-b', 'feature']);
  await repo.write('a.js', 'one\ncommitted change\nthree\nfour\nfive\n');
  await repo.run(['add', '-A']);
  await repo.run(['commit', '-m', 'branch change']);

  const before = {
    status: await repo.run(['status', '--porcelain=v1', '-z']),
    head: await repo.run(['rev-parse', 'HEAD']),
    index: await repo.run(['diff', '--staged', '--stat']),
    stash: await repo.run(['stash', 'list']),
    reflog: await repo.run(['reflog', '--format=%H %gs']),
  };

  const opened = JSON.parse((await cr(['open', '--base', 'main', '--json'])).out);
  assert.equal(opened.base, 'main');

  const port = await portFor(env);
  const token = await tokenFor(env, opened.key);

  await post(port, opened.key, token, '/comments', {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2,
    quote: 'committed change', body: 'x', verdict: 'fix',
  });
  await post(port, opened.key, token, '/send');
  await cr(['wait', '--timeout', '5']);
  await cr(['refresh']);

  // The base branch can vanish mid-session, e.g. once it is merged and
  // deleted; refresh must fail legibly (see Critical 1) and still never touch
  // the repository under review.
  await repo.run(['branch', '-D', 'main']);
  const refreshAfterDelete = await cr(['refresh']);
  assert.equal(refreshAfterDelete.code, 1);

  await cr(['close']);

  const after = {
    status: await repo.run(['status', '--porcelain=v1', '-z']),
    head: await repo.run(['rev-parse', 'HEAD']),
    index: await repo.run(['diff', '--staged', '--stat']),
    stash: await repo.run(['stash', 'list']),
    reflog: await repo.run(['reflog', '--format=%H %gs']),
  };

  assert.deepEqual(after, before, 'a --base session must never write to the repository under review, even once its base branch is gone');
});

test('a second agent waiting on the same session is refused', async (t) => {
  const { cr, env } = await setup(t);
  const opened = JSON.parse((await cr(['open', '--json'])).out);
  const port = await portFor(env);
  const token = await tokenFor(env, opened.key);

  const first = fetch(`http://127.0.0.1:${port}/api/sessions/${opened.key}/pending?holder=${process.pid}&timeout=5`, {
    headers: { 'x-cr-token': token },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const second = await cr(['wait', '--timeout', '5']);
  assert.equal(second.code, 1);
  assert.match(second.out, /another agent is waiting/);

  await post(port, opened.key, token, '/send');
  await first;
});

test('cr runs correctly when installed under a directory whose path contains a space', async (t) => {
  // Reproduces the bug directly: client.js resolves the daemon entry point
  // from import.meta.url, so the checkout's own location is what matters,
  // not the repository under review. `URL.pathname` on a path with a space
  // in it becomes `%20`, which is not a real filesystem path.
  const spacedRoot = await mkdtemp(path.join(tmpdir(), 'cr install '));
  t.after(() => rm(spacedRoot, { recursive: true, force: true }));
  await cp(PROJECT_ROOT, spacedRoot, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(PROJECT_ROOT, src);
      const top = rel.split(path.sep)[0];
      return !['node_modules', '.git', 'test', 'docs'].includes(top);
    },
  });
  const spacedBin = path.join(spacedRoot, 'bin', 'cr.js');

  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  const repo = await makeRepo({ 'a.js': 'one\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'ONE\n');
  const env = { ...process.env, CODEREVIEW_AXI_HOME: home };

  t.after(async () => {
    try {
      const { readFile } = await import('node:fs/promises');
      const { pid, port } = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
    } catch {
      // no server.json: nothing was ever spawned
    }
  });

  const { stdout } = await exec(process.execPath, [spacedBin, 'open', '--no-browser', '--json'], { cwd: repo.dir, env });
  const opened = JSON.parse(stdout);
  assert.equal(opened.reused, false);
});

test('a closed session is not resumed, and its comments do not come back', async (t) => {
  const { cr, env } = await setup(t);
  const first = JSON.parse((await cr(['open', '--note', 'first', '--json'])).out);
  const port = await portFor(env);
  const token = await tokenFor(env, first.key);

  await post(port, first.key, token, '/comments', {
    scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'TWO', body: 'old thread', verdict: 'fix',
  });
  await cr(['close']);

  const second = JSON.parse((await cr(['open', '--note', 'second', '--json'])).out);
  assert.equal(second.reused, false);
  assert.deepEqual(second.comments, []);
  assert.notEqual(await tokenFor(env, second.key), token);
});

test('closing the last open session stops the daemon', async (t) => {
  const { cr, env } = await setup(t);
  await cr(['open']);
  const port = await portFor(env);

  // Alive before the close, so a dead port afterwards means the close stopped
  // it rather than it never having been up.
  const before = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(before.status, 200);

  await cr(['close']);

  // The stop is deferred and re-checked, so poll rather than assert instantly.
  let reachable = true;
  for (let i = 0; i < 40 && reachable; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch {
      reachable = false;
    }
  }
  assert.equal(reachable, false, 'a finished review must not leave a daemon behind');
});

test('a second open keeps the daemon that a close had queued to stop', async (t) => {
  const { cr, env } = await setup(t);
  await cr(['open']);
  const port = await portFor(env);

  // The stop is scheduled by the close and decided 250ms later, so opening
  // inside that window must call it off: this is ordinary use, and deciding at
  // schedule time shot the daemon out from under the new session.
  await cr(['close']);
  await cr(['open']);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const res = await fetch(`http://127.0.0.1:${await portFor(env)}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(await portFor(env), port, 'the same daemon, not a replacement');
});
