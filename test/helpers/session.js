import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRepo } from './repo.js';

/**
 * Opens a session in a fresh repo with a working-tree edit, then posts each
 * comment straight to the server so its status stays whatever the caller
 * asked for (`open`, not `sent`) rather than going through the human's send.
 * @param {import('node:test').TestContext} t
 * @param {{body: string, verdict?: string}[]} comments
 * @returns {Promise<{repo: Awaited<ReturnType<typeof makeRepo>>, key: string, token: string, port: number}>}
 */
export const openSessionWithComments = async (t, comments) => {
  const home = await mkdtemp(path.join(tmpdir(), 'cr-home-'));
  process.env.CODEREVIEW_AXI_HOME = home;

  const { readServerFile } = await import('../../src/server/index.js');
  const { shutdown } = await import('../../src/cli/client.js');
  t.after(async () => {
    const info = await readServerFile();
    if (info) await shutdown(info.port, info.pid).catch(() => {});
  });
  t.after(() => { delete process.env.CODEREVIEW_AXI_HOME; });

  const { run } = await import('../../src/cli/commands.js');
  const { request } = await import('../../src/cli/client.js');
  const { loadState } = await import('../../src/state/store.js');

  const repo = await makeRepo({ 'a.js': 'one\ntwo\nthree\n' });
  t.after(repo.cleanup);
  await repo.write('a.js', 'one\nTWO\nthree\n');

  const opened = JSON.parse((await run({ argv: ['open', '--no-browser', '--json'], cwd: repo.dir, env: process.env })).out);
  const { port } = /** @type {{pid: number, port: number, version: string}} */ (await readServerFile());
  const { token } = (await loadState()).sessions[opened.key];

  for (const c of comments) {
    await request(port, 'POST', `/api/sessions/${opened.key}/comments`, {
      scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2, quote: 'TWO', body: c.body, verdict: c.verdict ?? 'fix',
    }, token);
  }

  return {
    repo, key: opened.key, token, port,
  };
};
