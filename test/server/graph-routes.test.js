import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';
import { buildChangeGraph } from '../../src/graph/build.js';
import { loadState, mutateState } from '../../src/state/store.js';

/**
 * @param {string} key
 */
const dropGraph = (key) => mutateState((state) => { delete state.sessions[key].graph; });

/**
 * @param {string} key
 */
const storedGraph = async (key) => {
  const session = (await loadState()).sessions[key];
  return 'graph' in session ? session.graph : 'missing';
};

/**
 * @param {import('node:test').TestContext} t
 */
const twoFileRepo = async (t) => {
  const repo = await makeRepo({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
  t.after(repo.cleanup);
  await repo.write('a.ts', "import { b } from './b';\nexport const a = b;\n");
  await repo.write('b.ts', 'export const b = 2;\n');
  return repo;
};

test('open and refresh store the change map on the session', async (t) => {
  const repo = await twoFileRepo(t);
  const { call } = await startApp(t);

  const opened = await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' });
  assert.equal(opened.status, 201);
  const { key, token } = opened.json;

  const first = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;
  assert.equal(first.graph.nodes.length, 2);
  assert.equal(first.graph.meta.version, 1);

  await repo.write('c.ts', 'export const c = 1;\n');
  const refreshed = await call('POST', `/api/sessions/${key}/refresh?t=${token}`, {});
  assert.equal(refreshed.status, 200);

  const second = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;
  assert.equal(second.graph.nodes.length, 3);
});

test('a graph build that throws still opens the session, with graph null', async (t) => {
  const repo = await twoFileRepo(t);
  const { call } = await startApp(t, { buildGraph: () => { throw new Error('boom'); } });

  const opened = await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' });
  assert.equal(opened.status, 201);

  const session = (await call('GET', `/api/sessions/${opened.json.key}?t=${opened.json.token}`)).json;
  assert.equal(session.graph, null);
});

test('an open session with no graph key gets the graph on GET', async (t) => {
  const repo = await twoFileRepo(t);
  const { call } = await startApp(t);
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  await dropGraph(key);

  const first = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;
  assert.equal(first.graph.nodes.length, 2);
  const second = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;
  assert.deepEqual(second.graph, first.graph);
  assert.equal(/** @type {any} */ (await storedGraph(key)).nodes.length, 2);
});

test('a stored null graph stays null and is not rebuilt', async (t) => {
  const repo = await twoFileRepo(t);
  let calls = 0;
  const { call } = await startApp(t, { buildGraph: () => { calls += 1; throw new Error('boom'); } });
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  assert.equal(calls, 1);

  const session = (await call('GET', `/api/sessions/${key}?t=${token}`)).json;
  assert.equal(session.graph, null);
  assert.equal(calls, 1);
});

test('a closed session with no graph key is not backfilled', async (t) => {
  const repo = await twoFileRepo(t);
  let calls = 0;
  const { call } = await startApp(t, { buildGraph: (root, files) => { calls += 1; return buildChangeGraph(root, files); } });
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  await call('POST', `/api/sessions/${key}/close?t=${token}`, { closedBy: 'human' });
  await dropGraph(key);
  const before = calls;

  const res = await call('GET', `/api/sessions/${key}?t=${token}`);
  assert.equal(res.status, 200);
  assert.equal('graph' in res.json, false);
  assert.equal(calls, before);
  assert.equal(await storedGraph(key), 'missing');
});

test('a failed backfill build stores null and GET still answers 200', async (t) => {
  const repo = await twoFileRepo(t);
  let calls = 0;
  const { call } = await startApp(t, {
    buildGraph: (root, files) => {
      calls += 1;
      if (calls > 1) throw new Error('boom');
      return buildChangeGraph(root, files);
    },
  });
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  await dropGraph(key);

  const res = await call('GET', `/api/sessions/${key}?t=${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.graph, null);
  assert.equal(await storedGraph(key), null);
});

test('a reused open stores the graph of the new snapshot', async (t) => {
  const repo = await twoFileRepo(t);
  const { call } = await startApp(t);
  const first = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  await repo.write('c.ts', 'export const c = 1;\n');

  const again = await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' });
  assert.equal(again.status, 201);
  assert.equal(again.json.reused, true);
  const session = (await call('GET', `/api/sessions/${first.key}?t=${first.token}`)).json;
  assert.equal(session.graph.nodes.length, 3);
});

test('a refresh between build and store keeps the refresh graph', async (t) => {
  const repo = await twoFileRepo(t);
  /** @type {any} */
  let realGraph;
  /** @type {any} */
  let refreshGraph;
  /** @type {Promise<unknown>|undefined} */
  let refreshLanded;
  let calls = 0;
  const { call } = await startApp(t, {
    buildGraph: (root, files) => {
      calls += 1;
      if (calls === 1) {
        realGraph = buildChangeGraph(root, files);
        return realGraph;
      }
      refreshGraph = { ...realGraph, nodes: [...realGraph.nodes, realGraph.nodes[0]] };
      refreshLanded = mutateState((state) => {
        for (const live of Object.values(state.sessions)) live.graph = refreshGraph;
      });
      return { ...realGraph, nodes: realGraph.nodes.slice(0, 1) };
    },
  });
  const { key, token } = (await call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  await dropGraph(key);

  const res = await call('GET', `/api/sessions/${key}?t=${token}`);
  assert.equal(res.status, 200);
  await refreshLanded;
  assert.equal(/** @type {any} */ (await storedGraph(key)).nodes.length, 3);
});
