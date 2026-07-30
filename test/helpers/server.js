import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Boots the app on an ephemeral port with an isolated state home.
 * @param {import('node:test').TestContext} t
 * @param {{now?: () => number}} [options]
 */
export const startApp = async (t, options = {}) => {
  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  process.env.CODEREVIEW_AXI_HOME = home;
  t.after(() => { delete process.env.CODEREVIEW_AXI_HOME; });

  const { createApp } = await import('../../src/server/app.js');

  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
  await new Promise((resolve) => probe.close(resolve));

  const app = createApp({ port, now: options.now ?? (() => Date.now()) });
  const server = http.createServer(app.handler);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

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
