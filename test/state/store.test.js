import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRepo } from '../helpers/repo.js';
import { buildSnapshot } from '../../src/diff/snapshot.js';

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

test('saveState tightens the mode of a pre-existing loose directory', async (t) => {
  const dir = await withHome(t);
  await chmod(dir, 0o755);
  const { saveState } = await import('../../src/state/store.js');

  await saveState({ sessions: {} });

  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('a session persisted before `base` existed still loads and behaves as a working-diff session', async (t) => {
  const dir = await withHome(t);

  const repo = await makeRepo({ 'a.js': 'one\ntwo\n' });
  t.after(repo.cleanup);
  await repo.run(['checkout', '-q', '-b', 'feature']);
  await repo.write('a.js', 'one\nCHANGED\n');
  await repo.run(['commit', '-qam', 'branch work']);
  await repo.write('a.js', 'one\nCHANGED\nextra\n');

  const legacySession = /** @type {any} */ ({
    key: 'legacy',
    token: 'tok',
    repo: repo.dir,
    url: 'http://127.0.0.1:1/session/legacy?t=tok',
    status: 'open',
    closedBy: null,
    note: '',
    snapshot: { files: [], totals: { files: 0, added: 0, removed: 0 } },
    snapshotAt: new Date(0).toISOString(),
    comments: [],
    chat: [],
    lease: null,
    view: 'unified',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    // deliberately no `base` key: this is what pre-base state files looked like
  });
  assert.ok(!('base' in legacySession), 'the fixture must genuinely omit base, not carry it as null');

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ sessions: { legacy: legacySession } }));

  const { loadState } = await import('../../src/state/store.js');
  const state = await loadState();
  const session = state.sessions.legacy;

  assert.ok(session, 'loadState must still surface a session that never had a base key');
  assert.ok(!('base' in session), 'loadState must not fill in a base for an older file');

  const [noBase, viaLoadedSession, withBase] = await Promise.all([
    buildSnapshot(repo.dir),
    buildSnapshot(repo.dir, /** @type {any} */ (session).base),
    buildSnapshot(repo.dir, 'main'),
  ]);

  assert.deepEqual(viaLoadedSession, noBase, 'an absent base must diff exactly like an explicit no-base session');
  assert.notDeepEqual(viaLoadedSession, withBase, 'and not like a session that recorded a base');
});

test('loadState rejects a file whose sessions field is not a record', async (t) => {
  const dir = await withHome(t);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), '{"sessions": "oops"}');
  const { loadState } = await import('../../src/state/store.js');
  assert.deepEqual(await loadState(), { sessions: {} });
});
