import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from '../helpers/repo.js';

const exec = promisify(execFile);
// `URL.pathname` percent-encodes a space, which is not a filesystem path.
const BIN = fileURLToPath(new URL('../../bin/cr.js', import.meta.url));

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
const runIn = async (cwd, args, env) => {
  try {
    const withFlags = args[0] === 'open' ? [...args, '--no-browser'] : args;
    const { stdout } = await exec(process.execPath, [BIN, ...withFlags], { cwd, env });
    return { code: 0, out: stdout };
  } catch (err) {
    const failure = /** @type {import('node:child_process').ExecFileException & {stdout?: string, stderr?: string}} */ (err);
    return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
};

const home = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  const { findPort } = await import('../../src/server/index.js');
  // A port of this file's own: cr uses one fixed port by design, so parallel
  // tests must not share it.
  const port = await findPort(45000 + Math.floor(Math.random() * 3000));
  return { ...process.env, CODEREVIEW_AXI_HOME: dir, CODEREVIEW_AXI_PORT: String(port) };
};

/**
 * Every verb but `help` and an unknown verb calls `ensureServer` before its
 * handler runs, spawning a real detached daemon even when the command then
 * fails for an unrelated reason. Left alone it outlives the test, so
 * teardown reaches it directly by pid over `/api/shutdown`.
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

test('exit 0 for help', async () => {
  assert.equal((await runIn(tmpdir(), ['help'], await home())).code, 0);
});

test('exit 1 outside a git worktree', async (t) => {
  const env = await home();
  t.after(() => killDaemon(env));

  const result = await runIn(tmpdir(), ['open'], env);
  assert.equal(result.code, 1);
  assert.match(result.out, /not inside a git worktree/);
});

test('exit 1 for an unknown verb, as a structured error', async () => {
  const result = await runIn(tmpdir(), ['frobnicate'], await home());
  assert.equal(result.code, 1);
  assert.match(result.out, /code: usage/);
  assert.match(result.out, /frobnicate/);
});

test('exit 1 with the nothing-to-review slug for a clean working tree', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  /** @type {NodeJS.ProcessEnv} */
  let env;
  // Registration order is run order: the daemon must die before repo.dir
  // (its cwd for the shutdown-triggering `cr` call) is removed.
  t.after(() => killDaemon(env));
  t.after(repo.cleanup);

  env = await home();
  const result = await runIn(repo.dir, ['open', '--json'], env);
  assert.equal(result.code, 1);
  assert.match(result.out, /nothing to review/);
  assert.equal(JSON.parse(result.out).error.code, 'nothing-to-review');
});

test('cr reply --body "--version" replies, it does not print the version', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  /** @type {NodeJS.ProcessEnv} */
  let env;
  t.after(() => killDaemon(env));
  t.after(repo.cleanup);

  env = await home();
  // argv[0] is 'reply', not '--version': only the first argument may switch
  // the whole command to printing the version (see bin/cr.js).
  const result = await runIn(repo.dir, ['reply', '--id', '1', '--status', 'fixed', '--body', '--version'], env);
  assert.doesNotMatch(result.out, /^0\.1\.0$/m, 'the literal package version must never be what this prints');
  assert.match(result.out, /no open session/, 'it should fail on the actual business rule (no open session), not short-circuit to --version');
});

test('exit 1 for a verb with no open session', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  /** @type {NodeJS.ProcessEnv} */
  let env;
  t.after(() => killDaemon(env));
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  env = await home();
  const result = await runIn(repo.dir, ['refresh'], env);
  assert.equal(result.code, 1);
  assert.match(result.out, /no open session/);
});

test('open prints TOON by default through the real bin/cr.js, not just through commands.js directly', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  /** @type {NodeJS.ProcessEnv} */
  let env;
  t.after(() => killDaemon(env));
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  env = await home();
  const result = await runIn(repo.dir, ['open'], env);
  assert.equal(result.code, 0, `expected a successful open, got ${result.code}: ${result.out}`);
  assert.match(result.out, /^key: /m, 'a TOON field line');
  assert.equal(result.out.trimStart().startsWith('{'), false, 'not JSON');
});

test('open ignores a stale server.json, since discovery is the port not the file', async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\n' });
  /** @type {NodeJS.ProcessEnv} */
  let env;
  t.after(() => killDaemon(env));
  t.after(repo.cleanup);
  await repo.write('a.js', 'two\n');

  env = await home();
  const stateDir = /** @type {string} */ (env.CODEREVIEW_AXI_HOME);
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'server.json'), JSON.stringify({ pid: 999999, port: 1, version: '0.0.0' }));

  // server.json is written for the record but no longer read to find a daemon,
  // so nonsense in it cannot mislead anyone: ensureServer health-checks the one
  // configured port and starts a daemon there if nothing answers. This used to
  // be a self-healing path through findPort, and the file being authoritative is
  // what let a machine collect eight daemons, one per open.
  const result = await runIn(repo.dir, ['open'], env);
  assert.equal(result.code, 0, `expected self-healing recovery, got ${result.code}: ${result.out}`);
});
