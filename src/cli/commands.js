import { parseArgs } from './args.js';
import { ensureServer, request, CliError } from './client.js';
import { openUrl } from './browser.js';
import { resolvePr as defaultResolvePr, parsePrNumber } from './pr.js';
import { toplevel, currentBranch } from '../diff/git.js';
import { loadState } from '../state/store.js';
import { sessionKey } from '../state/sessions.js';
import { shQuote } from '../shell.js';
import {
  USAGE, verbHelp, unknownFlags, checkArity, booleanFlagNames,
} from './spec.js';
import { encode } from './toon.js';
import { presentComment, selectFields } from './present.js';

export { USAGE } from './spec.js';

/**
 * @param {string} cwd
 * @returns {Promise<{key: string, token: string, repo: string}>}
 */
const resolveSession = async (cwd) => {
  const root = await toplevel(cwd);
  if (root === null) throw new CliError(1, `${cwd} is not inside a git worktree`, 'state');

  const key = sessionKey(root);
  const session = (await loadState()).sessions[key];
  if (!session) {
    throw new CliError(1, `no open session for ${root}, run cr open first`, 'state');
  }
  return { key, token: session.token, repo: root };
};

/**
 * @param {Record<string, string|boolean>} flags
 * @returns {string[]}
 */
const fieldsFrom = (flags) => {
  try {
    return selectFields(typeof flags.fields === 'string' ? flags.fields : undefined);
  } catch (err) {
    throw new CliError(1, err instanceof Error ? err.message : String(err), 'usage');
  }
};

/**
 * Every slug an exit-1 error can carry. The README documents each one, and a
 * test asserts the two lists agree, so a new slug can't drift out of sync
 * with the doc an agent is meant to read.
 */
export const ERROR_SLUGS = [
  'usage', 'state', 'nothing-to-review', 'server-unreachable', 'bad-response',
  'not-found', 'invalid-input', 'session-closed', 'agent-waiting', 'conflict', 'server-error',
];

/**
 * Turns an HTTP status (and, for a 409, the message) into a slug an agent
 * can branch on without parsing prose.
 * @param {number} status
 * @param {string} message
 * @returns {string}
 */
const slugForStatus = (status, message) => {
  if (status === 404) return 'not-found';
  if (status === 400) return 'invalid-input';
  if (status === 409) {
    if (message.includes('session is closed')) return 'session-closed';
    if (message.includes('another agent is waiting')) return 'agent-waiting';
    return 'conflict';
  }
  return 'server-error';
};

/**
 * @param {{status: number, json: any}} res
 * @returns {any}
 */
const unwrap = (res) => {
  if (res.status >= 200 && res.status < 300) return res.json;
  if (res.status === 422) throw new CliError(1, res.json?.error ?? 'nothing to review', 'nothing-to-review');
  const message = res.json?.error ?? `request failed with ${res.status}`;
  throw new CliError(1, message, slugForStatus(res.status, message));
};

/**
 * @typedef {(number: number|string, options?: {run?: (args: string[], cwd?: string) => Promise<string>, cwd?: string}) => Promise<{base: string, head: string}>} ResolvePr
 */

/** @type {Record<string, (input: {flags: Record<string, string|boolean>, cwd: string, port: number, resolvePr: ResolvePr}) => Promise<unknown>>} */
const HANDLERS = {
  open: async ({ flags, cwd, port, resolvePr }) => {
    const root = await toplevel(cwd);
    if (root === null) throw new CliError(1, `${cwd} is not inside a git worktree`, 'state');

    if (flags.pr !== undefined && flags.base !== undefined) {
      throw new CliError(1, '--pr and --base cannot be combined, the pull request determines the base', 'usage');
    }
    if (flags.base !== undefined && (typeof flags.base !== 'string' || flags.base === '')) {
      throw new CliError(1, '--base needs a value, for example --base main', 'usage');
    }

    /** @type {{repo: string, note: string, base?: string, pr?: number}} */
    const body = { repo: root, note: typeof flags.note === 'string' ? flags.note : '' };

    if (flags.pr !== undefined) {
      let n;
      try {
        n = parsePrNumber(flags.pr);
      } catch (err) {
        throw new CliError(1, err instanceof Error ? err.message : String(err), 'usage');
      }

      let resolved;
      try {
        resolved = await resolvePr(n, { cwd: root });
      } catch (err) {
        throw new CliError(1, err instanceof Error ? err.message : String(err), 'state');
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
        throw new CliError(1, `could not determine the current branch: ${detail}`, 'state');
      }
      if (branch !== resolved.head) {
        const head = shQuote(resolved.head);
        throw new CliError(1, `PR ${n} reviews ${resolved.head}, but the current branch is ${branch}. Run: git fetch origin ${head} && git checkout ${head}`, 'state');
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
    const fields = fieldsFrom(flags);
    const pending = unwrap(await request(port, 'GET', path, undefined, token));
    return { ...pending, comments: pending.comments.map((/** @type {any} */ c) => presentComment(c, fields)) };
  },

  list: async ({ flags, cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    const fields = fieldsFrom(flags);
    const session = unwrap(await request(port, 'GET', `/api/sessions/${key}`, undefined, token));
    const wanted = typeof flags.status === 'string' ? flags.status : null;

    const comments = wanted === null
      ? session.comments
      : session.comments.filter((/** @type {{status: string}} */ c) => c.status === wanted);
    return { comments: comments.map((/** @type {any} */ c) => presentComment(c, fields)) };
  },

  reply: async ({ flags, cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    const id = Number(flags.id);
    if (!Number.isInteger(id)) throw new CliError(1, 'reply needs --id N', 'usage');
    if (typeof flags.status !== 'string') throw new CliError(1, 'reply needs --status fixed|explained|skipped', 'usage');
    if (typeof flags.body !== 'string') throw new CliError(1, 'reply needs --body TEXT', 'usage');

    const body = { id, status: flags.status, body: flags.body };
    const comment = unwrap(await request(port, 'POST', `/api/sessions/${key}/replies`, body, token));
    // The agent just wrote the body; echoing it back is pure cost. counts
    // tells it whether anything else still awaits a reply, matching close.
    const session = unwrap(await request(port, 'GET', `/api/sessions/${key}`, undefined, token));
    return { id: comment.id, status: comment.status, counts: commentCounts(session.comments) };
  },

  refresh: async ({ cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    return unwrap(await request(port, 'POST', `/api/sessions/${key}/refresh`, {}, token));
  },

  close: async ({ cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    const session = unwrap(await request(port, 'POST', `/api/sessions/${key}/close`, { closedBy: 'agent' }, token));
    return {
      key: session.key,
      status: session.status,
      closedBy: session.closedBy,
      counts: commentCounts(session.comments),
    };
  },
};

/**
 * `total` plus one entry per status actually present, not every status
 * `Comment.status` could hold: axi principle 2, no zero-value noise.
 * @param {{status: string}[]} comments
 * @returns {Record<string, number>}
 */
const commentCounts = (comments) => {
  /** @type {Record<string, number>} */
  const counts = { total: comments.length };
  for (const { status } of comments) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
};

/**
 * Joins `files[].tags` into a space-separated string for `open`, `refresh`
 * and `close`, the one shape `toon.js` cannot carry that isn't a comment.
 * Comment presentation lives in `present.js`.
 * @param {unknown} value
 * @returns {unknown}
 */
const forDisplay = (value) => {
  if (Array.isArray(value)) return value.map(forDisplay);
  if (value === null || typeof value !== 'object') return value;

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'tags' && Array.isArray(v) ? v.join(' ') : forDisplay(v);
  }
  return out;
};

/**
 * `resolvePr` is injectable so tests can drive the `--pr` wiring without a
 * real `gh` on PATH, the same seam `resolvePr` itself uses for `gh`.
 * @param {{argv: string[], cwd: string, env?: NodeJS.ProcessEnv, resolvePr?: ResolvePr}} input
 * @returns {Promise<{code: number, out: string}>}
 */
export const run = async ({ argv, cwd, resolvePr = defaultResolvePr }) => {
  // A first, loose pass just to find the verb: only then do we know which
  // flags on this line are boolean, so a second pass can parse properly.
  const probeVerb = parseArgs(argv, booleanFlagNames()).verb;
  const { verb, flags, positional } = parseArgs(argv, booleanFlagNames(probeVerb));

  const asText = (/** @type {unknown} */ value) => (
    flags.json === true ? JSON.stringify(value, null, 2) : encode(/** @type {any} */ (value))
  );
  /** @param {CliError} err */
  const fail = (err) => ({ code: err.code, out: asText({ error: { code: err.slug, message: err.message } }) });

  if (verb === 'help') return { code: 0, out: USAGE };

  const handler = HANDLERS[verb];
  if (!handler) return fail(new CliError(1, `unknown verb "${verb}"`, 'usage'));

  if (flags.help === true) return { code: 0, out: verbHelp(verb) };

  const unknown = unknownFlags(verb, flags);
  if (unknown.length > 0) {
    const named = unknown.map((f) => `--${f}`).join(', ');
    return { code: 2, out: `unknown ${unknown.length === 1 ? 'flag' : 'flags'} ${named}\n\n${verbHelp(verb)}` };
  }

  const arityMessage = checkArity(verb, flags);
  if (arityMessage) return fail(new CliError(1, arityMessage, 'usage'));

  if (positional.length > 0) {
    return fail(new CliError(1, `cr ${verb} takes no positional arguments, got "${positional[0]}"`, 'usage'));
  }

  try {
    const port = await ensureServer();
    const result = await handler({
      flags, cwd, port, resolvePr,
    });
    return { code: 0, out: asText(forDisplay(result)) };
  } catch (err) {
    const code = err instanceof CliError ? err.code : 1;
    const slug = err instanceof CliError ? err.slug : 'error';
    const message = err instanceof Error ? err.message : String(err);
    return { code, out: asText({ error: { code: slug, message } }) };
  }
};

export const COMMANDS = HANDLERS;
