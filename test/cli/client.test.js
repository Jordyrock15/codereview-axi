import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

/** A port of this test's own, so parallel files do not collide on the fixed one. */
const freePort = async () => {
  const { findPort } = await import('../../src/server/index.js');
  return findPort(45000 + Math.floor(Math.random() * 3000));
};

/** @param {import('node:test').TestContext} t */
const withHome = async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  process.env.CODEREVIEW_AXI_HOME = home;
  // cr uses one fixed port, which is what stops a second daemon existing. Tests
  // run in parallel, so each needs its own or they fight over it.
  process.env.CODEREVIEW_AXI_PORT = String(await freePort());
  t.after(() => { delete process.env.CODEREVIEW_AXI_HOME; delete process.env.CODEREVIEW_AXI_PORT; });
  return home;
};

test('probe reports a dead port', async (t) => {
  await withHome(t);
  const { probe } = await import('../../src/cli/client.js');
  assert.deepEqual(await probe(45401), { ok: false });
});

test('probe reports version and pid for a live server', async (t) => {
  await withHome(t);
  const { startServer } = await import('../../src/server/index.js');
  const { probe } = await import('../../src/cli/client.js');

  const server = await startServer({ port: 45411 });
  t.after(server.close);

  const result = await probe(45411);
  assert.equal(result.ok, true);
  assert.equal(result.pid, process.pid);
  assert.match(/** @type {string} */ (result.version), /^\d+\.\d+\.\d+$/);
});

test('ensureServer spawns a server when none is recorded', async (t) => {
  const home = await withHome(t);
  const { ensureServer, probe, shutdown } = await import('../../src/cli/client.js');

  const port = await ensureServer();
  const info = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  t.after(() => shutdown(port, info.pid).catch(() => {}));

  assert.equal(info.port, port);
  assert.notEqual(info.pid, process.pid, 'the daemon runs in its own process');
  assert.equal((await probe(port)).ok, true);
});

test('ensureServer reuses a live server on the configured port', async (t) => {
  await withHome(t);
  const { startServer, configuredPort } = await import('../../src/server/index.js');
  const { ensureServer } = await import('../../src/cli/client.js');

  // Discovery is a health check on the one port, not a lookup in server.json.
  // That file can be lost while a daemon lives, which is how a machine ended up
  // with eight of them; a port cannot be lost while something is listening on it.
  const port = configuredPort();
  const server = await startServer({ port });
  t.after(server.close);

  assert.equal(await ensureServer(), port);
});

test('ensureServer replaces a server running an older version', async (t) => {
  const home = await withHome(t);
  const { ensureServer, shutdown, probe } = await import('../../src/cli/client.js');

  // A stand-in reporting an old version: a real server always reports its own
  // current one, so it can never exercise the replacement path.
  const stale = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.0.1', pid: 999999 }));
  });
  stale.listen(45431, '127.0.0.1');
  await once(stale, 'listening');
  t.after(() => new Promise((resolve) => stale.close(resolve)));

  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'server.json'), JSON.stringify({ pid: 999999, port: 45431, version: '0.0.1' }));

  const port = await ensureServer();
  const info = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  t.after(() => shutdown(port, info.pid).catch(() => {}));

  assert.notEqual(port, 45431, 'a fresh server was started rather than the stale one reused');

  const health = await probe(port);
  assert.equal(health.ok, true);
  assert.notEqual(health.version, '0.0.1', 'the replacement runs the current version');
});

test('ensureServer ignores a stale server.json pointing at a dead port', async (t) => {
  const home = await withHome(t);
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'server.json'), JSON.stringify({ pid: 999999, port: 45441, version: '9.9.9' }));

  const { ensureServer, shutdown } = await import('../../src/cli/client.js');
  const port = await ensureServer();
  const info = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  t.after(() => shutdown(port, info.pid).catch(() => {}));

  assert.notEqual(port, 45441);
});

test('request sends the token header and parses JSON', async (t) => {
  await withHome(t);
  const { startServer } = await import('../../src/server/index.js');
  const { request } = await import('../../src/cli/client.js');

  const server = await startServer({ port: 45451 });
  t.after(server.close);

  const res = await request(45451, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('request throws a CliError with the server-unreachable slug when the server is gone', async (t) => {
  await withHome(t);
  const { request, CliError } = await import('../../src/cli/client.js');

  await assert.rejects(() => request(45461, 'GET', '/api/health'), (err) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, 1);
    assert.equal(err.slug, 'server-unreachable');
    return true;
  });
});

test('request throws a CliError with the bad-response slug on an unparseable body', async (t) => {
  await withHome(t);
  const { request, CliError } = await import('../../src/cli/client.js');

  // The server answered, so this is not "unreachable": a body this CLI
  // cannot understand needs a slug of its own rather than reusing that one.
  const garbled = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not json');
  });
  garbled.listen(45471, '127.0.0.1');
  await once(garbled, 'listening');
  t.after(() => new Promise((resolve) => garbled.close(resolve)));

  await assert.rejects(() => request(45471, 'GET', '/api/health'), (err) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, 1);
    assert.equal(err.slug, 'bad-response');
    return true;
  });
});
