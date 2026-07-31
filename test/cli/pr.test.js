import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, writeFile, chmod, rm, realpath, readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePr } from '../../src/cli/pr.js';

/** @param {string|Error} result */
const fakeRun = (result) => async () => {
  if (result instanceof Error) throw result;
  return result;
};

test('resolvePr reads the base and head branches', async () => {
  const run = fakeRun(JSON.stringify({ baseRefName: 'main', headRefName: 'feature-x' }));
  assert.deepEqual(await resolvePr(123, { run }), { base: 'main', head: 'feature-x' });
});

test('resolvePr rejects when gh is missing', async () => {
  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  await assert.rejects(() => resolvePr(1, { run: fakeRun(missing) }), /not found on PATH/);
});

test('resolvePr suggests --base when gh is missing', async () => {
  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  await assert.rejects(() => resolvePr(1, { run: fakeRun(missing) }), /--base/);
});

test('resolvePr gives an unauthenticated gh (exit 4) its own message', async () => {
  const unauthenticated = Object.assign(new Error('command failed'), {
    code: 4,
    stderr: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
  });
  await assert.rejects(() => resolvePr(1, { run: fakeRun(unauthenticated) }), (err) => {
    assert.match(/** @type {Error} */ (err).message, /gh auth login/);
    assert.match(/** @type {Error} */ (err).message, /--base/);
    assert.doesNotMatch(/** @type {Error} */ (err).message, /Alternatively/);
    return true;
  });
});

test('resolvePr uses only the first line of multi-line stderr for a non-auth failure', async () => {
  const failed = Object.assign(new Error('command failed'), { stderr: 'no such pull request\nsecond line of noise' });
  await assert.rejects(() => resolvePr(1, { run: fakeRun(failed) }), (err) => {
    assert.match(/** @type {Error} */ (err).message, /no such pull request/);
    assert.doesNotMatch(/** @type {Error} */ (err).message, /second line of noise/);
    return true;
  });
});

test('resolvePr rejects an unparseable response', async () => {
  await assert.rejects(() => resolvePr(1, { run: fakeRun('not json') }), /could not read/);
});

test('resolvePr rejects a response missing the fields', async () => {
  await assert.rejects(() => resolvePr(1, { run: fakeRun('{}') }), /baseRefName/);
});

test('resolvePr rejects a non-integer number', async () => {
  await assert.rejects(() => resolvePr('abc', { run: fakeRun('{}') }), /number/);
});

test('resolvePr surfaces gh stderr for a non-ENOENT failure, e.g. not authenticated', async () => {
  const failed = Object.assign(new Error('command failed'), { stderr: 'gh: not authenticated to github.com' });
  await assert.rejects(
    () => resolvePr(1, { run: fakeRun(failed) }),
    /not authenticated to github\.com/,
  );
});

test('resolvePr also suggests --base for a non-ENOENT failure', async () => {
  const failed = Object.assign(new Error('command failed'), { stderr: 'no such pull request' });
  await assert.rejects(() => resolvePr(1, { run: fakeRun(failed) }), /--base/);
});

test('resolvePr runs gh in the given cwd, not the process cwd', async (t) => {
  const stubDir = await mkdtemp(path.join(tmpdir(), 'cr-ghstub-'));
  const target = await mkdtemp(path.join(tmpdir(), 'cr-target-'));
  t.after(() => rm(stubDir, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));

  const cwdFile = path.join(stubDir, 'reported-cwd');
  const ghPath = path.join(stubDir, 'gh');
  await writeFile(ghPath, [
    '#!/usr/bin/env node',
    `require('node:fs').writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());`,
    'process.stdout.write(JSON.stringify({ baseRefName: "main", headRefName: "feature-x" }));',
    '',
  ].join('\n'));
  await chmod(ghPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${stubDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  await resolvePr(1, { cwd: target });

  const reportedCwd = (await readFile(cwdFile, 'utf8')).trim();
  assert.equal(await realpath(reportedCwd), await realpath(target));
});
