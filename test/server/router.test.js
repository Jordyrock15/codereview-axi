import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRouter, sendJson } from '../../src/server/router.js';
import { StateError } from '../../src/state/errors.js';

/**
 * @param {import('../../src/server/router.js').Route[]} routes
 * @param {import('node:test').TestContext} t
 */
const serve = async (routes, t) => {
  const server = http.createServer(createRouter(routes));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a network address');
  const { port } = address;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  return async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? null : JSON.parse(text), headers: res.headers };
  };
};

test('matches a literal route and returns JSON', async (t) => {
  const call = await serve([
    { method: 'GET', pattern: '/api/ping', handler: async () => ({ body: { pong: true } }) },
  ], t);

  const res = await call('GET', '/api/ping');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { pong: true });
  assert.match(/** @type {string} */ (res.headers.get('content-type')), /application\/json/);
});

test('extracts named params and query', async (t) => {
  const call = await serve([
    {
      method: 'GET',
      pattern: '/api/sessions/:key/comments/:id',
      handler: async ({ params, query }) => ({ body: { params, t: query.get('t') } }),
    },
  ], t);

  const res = await call('GET', '/api/sessions/abc/comments/7?t=tok');
  assert.deepEqual(res.json.params, { key: 'abc', id: '7' });
  assert.equal(res.json.t, 'tok');
});

test('parses a JSON body', async (t) => {
  const call = await serve([
    { method: 'POST', pattern: '/api/echo', handler: async ({ body }) => ({ status: 201, body }) },
  ], t);

  const res = await call('POST', '/api/echo', { body: 'hello' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json, { body: 'hello' });
});

test('rejects a malformed JSON body with 400', async (t) => {
  const server = http.createServer(createRouter([
    { method: 'POST', pattern: '/api/echo', handler: async ({ body }) => ({ body }) },
  ]));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a network address');

  const res = await fetch(`http://127.0.0.1:${address.port}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(res.status, 400);
});

test('404s an unmatched path and 405s a wrong method', async (t) => {
  const call = await serve([
    { method: 'GET', pattern: '/api/ping', handler: async () => ({ body: {} }) },
  ], t);

  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('POST', '/api/ping')).status, 405);
});

test('turns a StateError into its status', async (t) => {
  const call = await serve([
    { method: 'GET', pattern: '/api/boom', handler: async () => { throw new StateError(409, 'conflicting'); } },
  ], t);

  const res = await call('GET', '/api/boom');
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'conflicting');
});

test('turns an unexpected throw into 500 without leaking a stack', async (t) => {
  const call = await serve([
    { method: 'GET', pattern: '/api/boom', handler: async () => { throw new Error('internal detail'); } },
  ], t);

  const res = await call('GET', '/api/boom');
  assert.equal(res.status, 500);
  assert.equal(res.json.error, 'internal error');
});

test('a handler that returns nothing is treated as 204', async (t) => {
  const call = await serve([
    { method: 'POST', pattern: '/api/void', handler: async () => {} },
  ], t);

  assert.equal((await call('POST', '/api/void')).status, 204);
});

test('a malformed percent-escape in a parameter gives 400 and does not crash', async (t) => {
  const call = await serve([
    { method: 'GET', pattern: '/api/s/:key', handler: async ({ params }) => ({ body: params }) },
  ], t);

  assert.equal((await call('GET', '/api/s/%zz')).status, 400);
  assert.equal((await call('GET', '/api/s/ok')).status, 200, 'the server is still alive');
});

test('a malformed request target gives 400', async (t) => {
  const call = await serve([
    { method: 'GET', pattern: '/api/ping', handler: async () => ({ body: {} }) },
  ], t);

  assert.equal((await call('GET', '/api/ping')).status, 200);
});

test('never sets CORS headers', async (t) => {
  const call = await serve([
    { method: 'GET', pattern: '/api/ping', handler: async () => ({ body: {} }) },
  ], t);

  const res = await call('GET', '/api/ping');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});
