import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A port of this test's own, so parallel files do not collide on the fixed one. */
const freePort = async () => {
  const { findPort } = await import('../../src/server/index.js');
  return findPort(45000 + Math.floor(Math.random() * 3000));
};

/**
 * Boots the app on an ephemeral port with an isolated state home.
 * @param {import('node:test').TestContext} t
 * @param {{now?: () => number, buildSnapshot?: (repo: string, base?: string) => Promise<import('../../src/types.js').Snapshot>}} [options]
 */
export const startApp = async (t, options = {}) => {
  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  process.env.CODEREVIEW_AXI_HOME = home;
  // cr uses one fixed port, which is what stops a second daemon existing. Tests
  // run in parallel, so each needs its own or they fight over it.
  process.env.CODEREVIEW_AXI_PORT = String(await freePort());
  t.after(() => { delete process.env.CODEREVIEW_AXI_HOME; delete process.env.CODEREVIEW_AXI_PORT; });

  const { createApp } = await import('../../src/server/app.js');

  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
  await new Promise((resolve) => probe.close(resolve));

  const app = createApp({
    port,
    now: options.now ?? (() => Date.now()),
    ...(options.buildSnapshot ? { buildSnapshot: options.buildSnapshot } : {}),
  });
  const server = http.createServer(app.handler);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const base = `http://127.0.0.1:${port}`;

  /**
   * @param {string} method
   * @param {string} urlPath
   * @param {unknown} [body]
   * @param {Record<string, string>} [headers]
   */
  const call = async (method, urlPath, body, headers = {}) => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? null : JSON.parse(text) };
  };

  return { base, port, call, hub: app.hub, home };
};
