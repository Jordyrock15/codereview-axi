import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';

/** @param {import('node:test').TestContext} t */
const setup = async (t) => {
  const repo = await makeRepo({ 'a.js': 'one\ntwo\nthree\nfour\nfive\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\nTWO\nthree\nfour\nfive\n');

  const app = await startApp(t);
  const { key, token } = (await app.call('POST', '/api/sessions', { repo: repo.dir, note: 'n' })).json;
  return { ...app, repo, key, token };
};

test('GET /session/:key serves HTML that loads the app script', async (t) => {
  const { base, key, token } = await setup(t);
  const res = await fetch(`${base}/session/${key}?t=${token}`);
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(html, /<script type="module" src="\/assets\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/styles\.css">/);
  assert.equal(html.includes(token), false, 'the token must not be baked into the HTML');
});

test('GET /session/:key still serves the shell without a token, the fetch is what fails', async (t) => {
  const { base, key } = await setup(t);
  assert.equal((await fetch(`${base}/session/${key}`)).status, 200);
});

test('GET /session/:key 404s an unknown key rather than rendering a page', async (t) => {
  const { base } = await setup(t);
  assert.equal((await fetch(`${base}/session/deadbeefdeadbeef`)).status, 404);
});

test('GET /session/:key carries CSP and X-Frame-Options headers', async (t) => {
  const { base, key, token } = await setup(t);
  const res = await fetch(`${base}/session/${key}?t=${token}`);

  assert.match(
    res.headers.get('content-security-policy') ?? '',
    /default-src 'none'.*script-src 'self'.*style-src 'self'.*connect-src 'self'/,
  );
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

// The session token lives in this URL's own query string, so a referrer leak
// to any third party a linked asset might point at would hand it over intact.
test('GET /session/:key carries Referrer-Policy and X-Content-Type-Options headers', async (t) => {
  const { base, key, token } = await setup(t);
  const res = await fetch(`${base}/session/${key}?t=${token}`);

  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('GET /session/:key 404s a crafted, non-existent key rather than rendering a page', async (t) => {
  const { base, key } = await setup(t);
  const crafted = `${key}" onload="fetch('http://evil')`;
  const res = await fetch(`${base}/session/${encodeURIComponent(crafted)}`);

  assert.equal(res.status, 404);
});

test('shellHtml escapes a hostile key rather than breaking out of the attribute', async () => {
  const { shellHtml } = await import('../../src/server/ui.js');
  const html = shellHtml(`x" onload="fetch('http://evil')`);

  assert.equal(html.includes('onload="'), false, 'the quote must be escaped so this never becomes a real attribute');
  assert.match(html, /data-key="x&quot; onload=&quot;fetch\(&#39;http:\/\/evil&#39;\)"/);
});

test('assets are served with correct content types and no directory traversal', async (t) => {
  const { base } = await setup(t);

  const js = await fetch(`${base}/assets/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);

  const css = await fetch(`${base}/assets/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);

  assert.equal((await fetch(`${base}/assets/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/assets/nope.js`)).status, 404);
});

test('assets carry Referrer-Policy and X-Content-Type-Options headers', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/assets/app.js`);

  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('GET context returns the requested working-tree lines', async (t) => {
  const { call, key, token } = await setup(t);
  const res = await call('GET', `/api/sessions/${key}/context?t=${token}&file=a.js&from=2&to=4`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.json.lines, ['TWO', 'three', 'four']);
  assert.equal(res.json.from, 2);
});

test('GET context 401s without a token', async (t) => {
  const { call, key } = await setup(t);
  assert.equal((await call('GET', `/api/sessions/${key}/context?file=a.js&from=1&to=2`)).status, 401);
});

test('GET context 400s without a file', async (t) => {
  const { call, key, token } = await setup(t);
  assert.equal((await call('GET', `/api/sessions/${key}/context?t=${token}&from=1&to=2`)).status, 400);
});

test('GET context 400s on a path outside the diff', async (t) => {
  const { call, key, token } = await setup(t);
  const res = await call('GET', `/api/sessions/${key}/context?t=${token}&file=../escape.txt&from=1&to=1`);

  assert.equal(res.status, 400);
  assert.match(res.json.error, /not a file in this diff/);
});

test('GET context 400s on non-numeric bounds', async (t) => {
  const { call, key, token } = await setup(t);
  const res = await call('GET', `/api/sessions/${key}/context?t=${token}&file=a.js&from=nope&to=also-nope`);
  assert.equal(res.status, 400);
});
