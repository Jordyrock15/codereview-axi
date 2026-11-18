import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';

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
