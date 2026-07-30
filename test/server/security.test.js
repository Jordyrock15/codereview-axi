import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../../src/server/security.js';

const session = /** @type {any} */ ({ token: 'a'.repeat(64) });
/** @returns {any} */
const call = (overrides = {}) => guard({
  headers: { host: '127.0.0.1:4390' },
  url: `/api/sessions/abc?t=${session.token}`,
  port: 4390,
  session,
  ...overrides,
});

test('allows a loopback request with the right token', () => {
  assert.deepEqual(call(), { ok: true });
});

test('accepts the token in a header instead of the query', () => {
  const result = call({ url: '/api/sessions/abc', headers: { host: 'localhost:4390', 'x-cr-token': session.token } });
  assert.equal(result.ok, true);
});

test('accepts localhost as well as the loopback address', () => {
  assert.equal(call({ headers: { host: 'localhost:4390' } }).ok, true);
});

test('rejects a missing token with 401', () => {
  const result = call({ url: '/api/sessions/abc' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('rejects a wrong token with 401', () => {
  const result = call({ url: '/api/sessions/abc?t=' + 'b'.repeat(64) });
  assert.equal(result.status, 401);
});

test('rejects a token of the wrong length without leaking timing', () => {
  assert.equal(call({ url: '/api/sessions/abc?t=short' }).status, 401);
});

test('rejects a foreign Host, which is what stops DNS rebinding', () => {
  const result = call({ headers: { host: 'evil.example.com' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('rejects a Host on the wrong port', () => {
  assert.equal(call({ headers: { host: '127.0.0.1:9999' } }).status, 403);
});

test('rejects a missing Host', () => {
  assert.equal(call({ headers: {} }).status, 403);
});

test('rejects a mismatched Origin', () => {
  const result = call({ headers: { host: '127.0.0.1:4390', origin: 'https://evil.example.com' } });
  assert.equal(result.status, 403);
});

test('allows a matching Origin', () => {
  assert.equal(call({ headers: { host: '127.0.0.1:4390', origin: 'http://127.0.0.1:4390' } }).ok, true);
});

test('rejects with 404 when the session does not exist', () => {
  const result = call({ session: null });
  assert.equal(result.status, 404);
});
