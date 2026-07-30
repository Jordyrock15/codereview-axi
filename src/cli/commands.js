import { parseArgs } from './args.js';
import { ensureServer, request, CliError } from './client.js';
import { openUrl } from './browser.js';
import { toplevel } from '../diff/git.js';
import { loadState } from '../state/store.js';
import { sessionKey } from '../state/sessions.js';

const USAGE = [
  'usage: cr <verb> [flags]',
  '',
  '  open     [--note TEXT] [--no-browser]   start or resume a review of the working diff',
  '  wait     [--timeout 300] [--say TEXT]   block until the human sends comments',
  '  list     [--status open]                 print comments without blocking',
  '  reply    --id N --status S --body TEXT   answer one comment (fixed|explained|skipped)',
  '  refresh                                  recompute the diff and push it to the tab',
  '  close                                    end the session',
  '',
  'exit codes: 0 ok, 1 usage or state, 2 nothing to review, 3 server unreachable',
].join('\n');

/**
 * @param {string} cwd
 * @returns {Promise<{key: string, token: string, repo: string}>}
 */
const resolveSession = async (cwd) => {
  const root = await toplevel(cwd);
  if (root === null) throw new CliError(1, `${cwd} is not inside a git worktree`);

  const key = sessionKey(root);
  const session = (await loadState()).sessions[key];
  if (!session) {
    throw new CliError(1, `no open session for ${root}, run cr open first`);
  }
  return { key, token: session.token, repo: root };
};

/**
 * @param {{status: number, json: any}} res
 * @returns {any}
 */
const unwrap = (res) => {
  if (res.status >= 200 && res.status < 300) return res.json;
  if (res.status === 422) throw new CliError(2, res.json?.error ?? 'nothing to review');
  throw new CliError(1, res.json?.error ?? `request failed with ${res.status}`);
};

/** @type {Record<string, (input: {flags: Record<string, string|boolean>, cwd: string, port: number}) => Promise<unknown>>} */
const HANDLERS = {
  open: async ({ flags, cwd, port }) => {
    const root = await toplevel(cwd);
    if (root === null) throw new CliError(1, `${cwd} is not inside a git worktree`);

    const body = { repo: root, note: typeof flags.note === 'string' ? flags.note : '' };
    const created = unwrap(await request(port, 'POST', '/api/sessions', body));

    if (flags['no-browser'] !== true) await openUrl(created.url);

    const { token, ...rest } = created;
    return rest;
  },

  wait: async ({ flags, cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    const timeout = Number(flags.timeout ?? 300);

    // --say is the agent talking to the human, so it updates the note the tab
    // header shows. Posting it as a comment would send it straight back.
    if (typeof flags.say === 'string' && flags.say !== '') {
      await request(port, 'PATCH', `/api/sessions/${key}/note`, { note: flags.say }, token);
    }

    const path = `/api/sessions/${key}/pending?holder=${process.pid}&timeout=${timeout}`;
    return unwrap(await request(port, 'GET', path, undefined, token));
  },

  list: async ({ flags, cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    const session = unwrap(await request(port, 'GET', `/api/sessions/${key}`, undefined, token));
    const wanted = typeof flags.status === 'string' ? flags.status : null;

    return {
      comments: wanted === null
        ? session.comments
        : session.comments.filter((/** @type {{status: string}} */ c) => c.status === wanted),
    };
  },

  reply: async ({ flags, cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    const id = Number(flags.id);
    if (!Number.isInteger(id)) throw new CliError(1, 'reply needs --id N');
    if (typeof flags.status !== 'string') throw new CliError(1, 'reply needs --status fixed|explained|skipped');
    if (typeof flags.body !== 'string') throw new CliError(1, 'reply needs --body TEXT');

    const body = { id, status: flags.status, body: flags.body };
    return unwrap(await request(port, 'POST', `/api/sessions/${key}/replies`, body, token));
  },

  refresh: async ({ cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    return unwrap(await request(port, 'POST', `/api/sessions/${key}/refresh`, {}, token));
  },

  close: async ({ cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    return unwrap(await request(port, 'POST', `/api/sessions/${key}/close`, { closedBy: 'agent' }, token));
  },
};

/**
 * @param {{argv: string[], cwd: string, env: NodeJS.ProcessEnv}} input
 * @returns {Promise<{code: number, out: string}>}
 */
export const run = async ({ argv, cwd }) => {
  const { verb, flags } = parseArgs(argv);

  if (verb === 'help' || flags.help === true) return { code: 0, out: USAGE };

  const handler = HANDLERS[verb];
  if (!handler) return { code: 1, out: `unknown verb "${verb}"\n\n${USAGE}` };

  try {
    const port = await ensureServer();
    const result = await handler({ flags, cwd, port });
    return { code: 0, out: JSON.stringify(result, null, 2) };
  } catch (err) {
    if (err instanceof CliError) return { code: err.code, out: err.message };
    return { code: 1, out: err instanceof Error ? err.message : String(err) };
  }
};

export const COMMANDS = HANDLERS;
