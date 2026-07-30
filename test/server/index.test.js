import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @param {import('node:test').TestContext} t */
const withHome = async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  process.env.CODEREVIEW_AXI_HOME = home;
  t.after(() => { delete process.env.CODEREVIEW_AXI_HOME; });
  return home;
};

test('findPort returns the requested port when it is free', async (t) => {
  await withHome(t);
  const { findPort } = await import('../../src/server/index.js');
  const port = await findPort(45231);
  assert.equal(port, 45231);
});

test('findPort scans upward past an occupied port', async (t) => {
  await withHome(t);
  const { findPort } = await import('../../src/server/index.js');

  const blocker = http.createServer();
  blocker.listen(45241, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  assert.equal(await findPort(45241), 45242);
});

test('findPort throws after exhausting its attempts', async (t) => {
  await withHome(t);
  const { findPort } = await import('../../src/server/index.js');
  await assert.rejects(() => findPort(45251, 0), /no free port/);
});

test('startServer binds loopback only and writes server.json', async (t) => {
  await withHome(t);
  const { startServer, readServerFile } = await import('../../src/server/index.js');

  const server = await startServer({ port: 45261 });
  t.after(server.close);

  const info = await readServerFile();
  assert.ok(info);
  assert.equal(info.port, 45261);
  assert.equal(info.pid, process.pid);
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
});

test('health responds without a token', async (t) => {
  await withHome(t);
  const { startServer } = await import('../../src/server/index.js');

  const server = await startServer({ port: 45271 });
  t.after(server.close);

  const res = await fetch('http://127.0.0.1:45271/api/health');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.pid, process.pid);
});

test('health refuses a foreign Host', async (t) => {
  await withHome(t);
  const { startServer } = await import('../../src/server/index.js');

  const server = await startServer({ port: 45281 });
  t.after(server.close);

  // fetch() treats Host as a forbidden header and silently overwrites it with
  // the real connection authority (WHATWG fetch spec, enforced by undici on
  // Node 20/22), so it can never actually deliver a foreign Host to the
  // server. http.request has no such restriction and puts one on the wire.
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 45281,
      path: '/api/health',
      headers: { Host: 'evil.example.com' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('the server is not reachable off loopback', async (t) => {
  await withHome(t);
  const { startServer } = await import('../../src/server/index.js');
  const server = await startServer({ port: 45291 });
  t.after(server.close);

  const { networkInterfaces } = await import('node:os');
  const external = Object.values(networkInterfaces())
    .flat()
    .find((nic) => nic && nic.family === 'IPv4' && !nic.internal);

  if (!external) return; // No external interface on this machine, nothing to prove.

  await assert.rejects(() => fetch(`http://${external.address}:45291/api/health`));
});

test('close removes server.json', async (t) => {
  await withHome(t);
  const { startServer, readServerFile } = await import('../../src/server/index.js');
  const server = await startServer({ port: 45301 });
  await server.close();
  assert.equal(await readServerFile(), null);
});

test('POST /api/shutdown with the right pid stops the server', async (t) => {
  await withHome(t);
  const { startServer } = await import('../../src/server/index.js');
  const server = await startServer({ port: 45311 });

  const res = await fetch('http://127.0.0.1:45311/api/shutdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: process.pid }),
  });
  assert.equal(res.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(() => fetch('http://127.0.0.1:45311/api/health'));
});

test('POST /api/shutdown with a wrong pid is refused', async (t) => {
  await withHome(t);
  const { startServer } = await import('../../src/server/index.js');
  const server = await startServer({ port: 45321 });
  t.after(server.close);

  const res = await fetch('http://127.0.0.1:45321/api/shutdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: 1 }),
  });
  assert.equal(res.status, 403);
  assert.equal((await fetch('http://127.0.0.1:45321/api/health')).status, 200);
});
