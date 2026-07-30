import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../../src/server/sse.js';

const fakeRes = () => {
  /** @type {string[]} */
  const writes = [];
  return {
    writes,
    /** @type {{status: number, headers: Record<string, string>} | null} */
    headers: null,
    /** @param {number} status @param {Record<string, string>} headers */
    writeHead(status, headers) { this.headers = { status, headers }; return this; },
    /** @param {string} chunk */
    write(chunk) { writes.push(chunk); return true; },
    end() { this.ended = true; },
    ended: false,
  };
};

test('subscribe sends SSE headers and an initial comment to open the stream', () => {
  const hub = createHub();
  const res = fakeRes();
  hub.subscribe('k1', res);

  assert.ok(res.headers);
  assert.equal(res.headers.status, 200);
  assert.equal(res.headers.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.headers.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(res.headers.headers.Connection, 'keep-alive');
  assert.equal(res.headers.headers['Access-Control-Allow-Origin'], undefined, 'never emit CORS headers');
  assert.match(res.writes[0], /^: connected\n\n$/);
});

test('publish frames event and JSON data for every subscriber of that key', () => {
  const hub = createHub();
  const a = fakeRes();
  const b = fakeRes();
  hub.subscribe('k1', a);
  hub.subscribe('k1', b);

  const delivered = hub.publish('k1', 'refreshed', { files: 2 });

  assert.equal(delivered, 2);
  assert.equal(a.writes[1], 'event: refreshed\ndata: {"files":2}\n\n');
  assert.equal(b.writes[1], a.writes[1]);
});

test('publish ignores other keys', () => {
  const hub = createHub();
  const res = fakeRes();
  hub.subscribe('k1', res);
  assert.equal(hub.publish('k2', 'refreshed', {}), 0);
  assert.equal(res.writes.length, 1);
});

test('the returned unsubscribe removes the subscriber', () => {
  const hub = createHub();
  const res = fakeRes();
  const off = hub.subscribe('k1', res);
  off();
  assert.equal(hub.count('k1'), 0);
  assert.equal(hub.publish('k1', 'refreshed', {}), 0);
});

test('a subscriber that throws on write is dropped rather than breaking publish', () => {
  const hub = createHub();
  const bad = fakeRes();
  bad.write = () => { throw new Error('socket gone'); };
  const good = fakeRes();
  hub.subscribe('k1', bad);
  hub.subscribe('k1', good);

  assert.equal(hub.publish('k1', 'refreshed', {}), 1);
  assert.equal(hub.count('k1'), 1);
});

test('a response whose writeHead throws is handled without breaking subscribe', () => {
  const hub = createHub();
  const res = fakeRes();
  res.writeHead = () => { throw new Error('headers already sent'); };

  assert.doesNotThrow(() => hub.subscribe('k1', res));
  assert.equal(hub.count('k1'), 0);
  assert.equal(hub.publish('k1', 'refreshed', {}), 0);
});

test('a dead-on-arrival subscriber on a fresh key leaves the key usable for later subscribers', () => {
  const hub = createHub();
  const dead = fakeRes();
  dead.write = () => { throw new Error('socket gone'); };
  hub.subscribe('k1', dead);

  assert.equal(hub.publish('k1', 'refreshed', {}), 0);

  const live = fakeRes();
  hub.subscribe('k1', live);
  assert.equal(hub.publish('k1', 'refreshed', {}), 1);
});

test('multi-line JSON never breaks framing', () => {
  const hub = createHub();
  const res = fakeRes();
  hub.subscribe('k1', res);
  hub.publish('k1', 'comment', { body: 'line one\nline two' });
  assert.equal(res.writes[1].split('\n').filter((l) => l.startsWith('data: ')).length, 1);
});
