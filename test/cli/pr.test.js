import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  await assert.rejects(() => resolvePr(1, { run: fakeRun(missing) }), /gh/);
});

test('resolvePr suggests --base when gh is missing', async () => {
  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  await assert.rejects(() => resolvePr(1, { run: fakeRun(missing) }), /--base/);
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
