import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @param {import('node:test').TestContext} t */
const withHome = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  process.env.CODEREVIEW_AXI_HOME = dir;
  t.after(() => { delete process.env.CODEREVIEW_AXI_HOME; });
  return dir;
};

test('loadState returns an empty shape when no file exists', async (t) => {
  await withHome(t);
  const { loadState } = await import('../../src/state/store.js');
  assert.deepEqual(await loadState(), { sessions: {} });
});

test('saveState writes 0600 and round-trips', async (t) => {
  const dir = await withHome(t);
  const { loadState, saveState } = await import('../../src/state/store.js');

  await saveState({ sessions: { abc: /** @type {any} */ ({ key: 'abc', note: 'hello' }) } });

  const mode = (await stat(path.join(dir, 'state.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await loadState()).sessions.abc.note, 'hello');
});

test('saveState leaves no temp file behind', async (t) => {
  const dir = await withHome(t);
  const { saveState } = await import('../../src/state/store.js');
  await saveState({ sessions: {} });
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('loadState recovers from a corrupt file rather than throwing', async (t) => {
  const dir = await withHome(t);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), '{ not json');
  const { loadState } = await import('../../src/state/store.js');
  assert.deepEqual(await loadState(), { sessions: {} });
});

test('mutateState serialises concurrent writers without losing updates', async (t) => {
  await withHome(t);
  const { mutateState, loadState } = await import('../../src/state/store.js');

  await Promise.all(
    Array.from({ length: 20 }, (_, i) => mutateState((state) => {
      state.sessions[`s${i}`] = /** @type {any} */ ({ key: `s${i}` });
      return i;
    })),
  );

  assert.equal(Object.keys((await loadState()).sessions).length, 20);
});

test('mutateState returns the callback result', async (t) => {
  await withHome(t);
  const { mutateState } = await import('../../src/state/store.js');
  assert.equal(await mutateState(() => 'value'), 'value');
});
