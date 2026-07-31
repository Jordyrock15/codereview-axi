import { parseArgs } from './args.js';
import { ensureServer, request, CliError } from './client.js';
import { openUrl } from './browser.js';
import { resolvePr as defaultResolvePr, parsePrNumber } from './pr.js';
import { toplevel, currentBranch } from '../diff/git.js';
import { loadState } from '../state/store.js';
import { sessionKey } from '../state/sessions.js';
import { shQuote } from '../shell.js';
import { USAGE, verbHelp, unknownFlags } from './spec.js';

export { USAGE } from './spec.js';

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

/**
 * @typedef {(number: number|string, options?: {run?: (args: string[], cwd?: string) => Promise<string>, cwd?: string}) => Promise<{base: string, head: string}>} ResolvePr
 */

/** @type {Record<string, (input: {flags: Record<string, string|boolean>, cwd: string, port: number, resolvePr: ResolvePr}) => Promise<unknown>>} */
const HANDLERS = {
  open: async ({ flags, cwd, port, resolvePr }) => {
    const root = await toplevel(cwd);
    if (root === null) throw new CliError(1, `${cwd} is not inside a git worktree`);

    if (flags.pr !== undefined && flags.base !== undefined) {
      throw new CliError(1, '--pr and --base cannot be combined, the pull request determines the base');
    }
    if (flags.base !== undefined && (typeof flags.base !== 'string' || flags.base === '')) {
      throw new CliError(1, '--base needs a value, for example --base main');
    }

    /** @type {{repo: string, note: string, base?: string, pr?: number}} */
    const body = { repo: root, note: typeof flags.note === 'string' ? flags.note : '' };

    if (flags.pr !== undefined) {
      let n;
      try {
        n = parsePrNumber(flags.pr);
      } catch (err) {
        throw new CliError(1, err instanceof Error ? err.message : String(err));
      }

      let resolved;
      try {
        resolved = await resolvePr(n, { cwd: root });
      } catch (err) {
        throw new CliError(1, err instanceof Error ? err.message : String(err));
      }

      let branch;
      try {
        branch = await currentBranch(root);
      } catch (/** @type {any} */ err) {
        // An unborn HEAD (no commits yet on this branch) fails `rev-parse`
        // with git's raw "Command failed" prose; give it a message of its own.
        const detail = typeof err?.stderr === 'string' && err.stderr.trim() !== ''
          ? err.stderr.trim().split('\n')[0]
          : (err instanceof Error ? err.message : String(err));
        throw new CliError(1, `could not determine the current branch: ${detail}`);
      }
      if (branch !== resolved.head) {
        const head = shQuote(resolved.head);
        throw new CliError(1, `PR ${n} reviews ${resolved.head}, but the current branch is ${branch}. Run: git fetch origin ${head} && git checkout ${head}`);
      }

      body.base = resolved.base;
      body.pr = n;
    } else if (typeof flags.base === 'string') {
      body.base = flags.base;
    }

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
      const said = await request(port, 'PATCH', `/api/sessions/${key}/note`, { note: flags.say }, token);
      // A closed session refuses the note, which is fine: the poll below is
      // about to tell the agent the review is over.
      if (said.status !== 409) unwrap(said);
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
 * `resolvePr` is injectable so tests can drive the `--pr` wiring without a
 * real `gh` on PATH, the same seam `resolvePr` itself uses for `gh`.
 * @param {{argv: string[], cwd: string, env?: NodeJS.ProcessEnv, resolvePr?: ResolvePr}} input
 * @returns {Promise<{code: number, out: string}>}
 */
export const run = async ({ argv, cwd, resolvePr = defaultResolvePr }) => {
  const { verb, flags } = parseArgs(argv);

  if (verb === 'help') return { code: 0, out: USAGE };

  const handler = HANDLERS[verb];
  if (!handler) return { code: 1, out: `unknown verb "${verb}"\n\n${USAGE}` };

  if (flags.help === true) return { code: 0, out: verbHelp(verb) };

  const unknown = unknownFlags(verb, flags);
  if (unknown.length > 0) {
    const named = unknown.map((f) => `--${f}`).join(', ');
    return { code: 2, out: `unknown ${unknown.length === 1 ? 'flag' : 'flags'} ${named}\n\n${verbHelp(verb)}` };
  }

  try {
    const port = await ensureServer();
    const result = await handler({
      flags, cwd, port, resolvePr,
    });
    return { code: 0, out: JSON.stringify(result, null, 2) };
  } catch (err) {
    if (err instanceof CliError) return { code: err.code, out: err.message };
    return { code: 1, out: err instanceof Error ? err.message : String(err) };
  }
};

export const COMMANDS = HANDLERS;
