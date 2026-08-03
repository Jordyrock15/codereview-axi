import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.js';
import { ensureServer, request, CliError } from './client.js';
import { openUrl } from './browser.js';
import { resolvePr as defaultResolvePr, parsePrNumber } from './pr.js';
import {
  toplevel, currentBranch, isOptionShaped,
} from '../diff/git.js';
import { loadState } from '../state/store.js';
import { sessionKey } from '../state/sessions.js';
import { shQuote } from '../shell.js';
import {
  USAGE, verbHelp, unknownFlags, checkArity, booleanFlagNames,
} from './spec.js';
import { encode } from './toon.js';
import {
  presentComment, selectFields, nextSteps, nextStep,
} from './present.js';
import { installHook } from './setup.js';

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
 * A flag declared with an `arg` in spec.js (so it expects a value) arrives as
 * boolean `true` when given with nothing after it, indistinguishable from a
 * genuine boolean flag. Left unchecked, that reads as "flag absent" to every
 * caller downstream, so the narrower question the agent asked gets silently
 * answered as if it had never asked at all.
 * @param {Record<string, string|boolean>} flags
 * @param {string} name
 * @param {string} example
 * @returns {void}
 */
const requireValue = (flags, name, example) => {
  if (flags[name] === true) {
    throw new CliError(1, `--${name} needs a value, for example --${name} ${example}`, 'usage');
  }
};

/**
 * `Number(true)` is `1`, finite and positive, so a bare `--timeout` with no
 * value would sail through a numeric check alone; `requireValue` must run
 * first. `Number("abc")` is `NaN`, which `setTimeout` fires on immediately,
 * turning a mistyped timeout into a hot loop against the server rather than
 * a poll.
 * @param {Record<string, string|boolean>} flags
 * @returns {number}
 */
const parseTimeout = (flags) => {
  requireValue(flags, 'timeout', '300');
  if (flags.timeout === undefined) return 300;
  const n = Number(flags.timeout);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(1, `--timeout must be a positive number of seconds, got "${flags.timeout}"`, 'usage');
  }
  return n;
};

/**
 * @param {Record<string, string|boolean>} flags
 * @returns {string[]}
 */
const fieldsFrom = (flags) => {
  requireValue(flags, 'fields', 'id,body,quote');
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
  'not-found', 'invalid-input', 'session-closed', 'agent-waiting', 'conflict', 'diff-too-large', 'server-error', 'error',
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
  if (status === 413) return 'diff-too-large';
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

/** @type {Record<string, (input: {flags: Record<string, string|boolean>, cwd: string, port: number, resolvePr: ResolvePr, homedir: () => string}) => Promise<unknown>>} */
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
    requireValue(flags, 'note', '"refactored the payout splitter"');

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

      // `resolved.head` is attacker-controlled: it comes from `gh`, which is
      // relaying whatever the PR author named their branch. A ref shaped like
      // an option (`--upload-pack=...`) must never reach the suggested `git
      // fetch` command below, quoting alone is not enough (see isOptionShaped).
      if (isOptionShaped(resolved.head)) {
        throw new CliError(1, `PR ${n}'s head branch "${resolved.head}" is not a valid ref name`, 'invalid-input');
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
        // `--` closes option parsing for both git subcommands: shQuote alone
        // stops the shell, not git's own flag parser, and isOptionShaped above
        // is a check, not a guarantee against every shape a future ref could take.
        throw new CliError(1, `PR ${n} reviews ${resolved.head}, but the current branch is ${branch}. Run: git fetch origin -- ${head} && git switch -- ${head}`, 'state');
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
    const timeout = parseTimeout(flags);
    requireValue(flags, 'say', '"check the rounding first"');

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
    const limit = flags.full === true ? Infinity : undefined;
    const pending = unwrap(await request(port, 'GET', path, undefined, token));
    const session = unwrap(await request(port, 'GET', `/api/sessions/${key}`, undefined, token));
    const counts = commentCounts(session.comments);

    if (pending.comments.length === 0) {
      const { comments, ...rest } = pending;
      return { ...rest, empty: `no comments (0 of ${session.comments.length})`, counts };
    }

    return { ...pending, comments: pending.comments.map((/** @type {any} */ c) => presentComment(c, fields, { limit })), counts };
  },

  list: async ({ flags, cwd, port }) => {
    const { key, token } = await resolveSession(cwd);
    requireValue(flags, 'status', 'open');
    const fields = fieldsFrom(flags);
    const limit = flags.full === true ? Infinity : undefined;
    const session = unwrap(await request(port, 'GET', `/api/sessions/${key}`, undefined, token));
    const wanted = typeof flags.status === 'string' ? flags.status : null;

    const all = session.comments;
    const matched = wanted === null
      ? all
      : all.filter((/** @type {{status: string}} */ c) => c.status === wanted);
    const counts = commentCounts(all);

    if (matched.length === 0) {
      const filter = wanted === null ? '' : ` match status=${wanted}`;
      return { empty: `no comments (0 of ${all.length}${filter})`, counts };
    }

    return { comments: matched.map((/** @type {any} */ c) => presentComment(c, fields, { limit })), counts };
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
    // fix tells nextStep whether refresh is worth mentioning: an explain-only
    // batch changes no code, so refresh would be a pointless no-op.
    const session = unwrap(await request(port, 'GET', `/api/sessions/${key}`, undefined, token));
    return {
      id: comment.id,
      status: comment.status,
      counts: commentCounts(session.comments),
      fix: fixCounts(session.comments, comment),
    };
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

  // Deliberately no `port` in scope: this touches Claude Code's own settings,
  // nothing to do with the review server, so it must never start one.
  setup: async ({ flags, cwd, homedir }) => {
    let settingsPath;
    if (flags.global === true) {
      settingsPath = path.join(homedir(), '.claude', 'settings.json');
    } else {
      const root = await toplevel(cwd);
      if (root === null) throw new CliError(1, `${cwd} is not inside a git worktree`, 'state');
      settingsPath = path.join(root, '.claude', 'settings.local.json');
    }

    // A bare `cr` is resolved through PATH at session-start time, on every
    // future session: a dependency shipping its own `cr` binary ahead on
    // PATH would run silently, and a PATH change would fail the hook forever
    // with nothing indicating what wrote it. The absolute interpreter plus
    // script path is immune to both.
    const binPath = fileURLToPath(new URL('../../bin/cr.js', import.meta.url));
    // Both quoted: the hook command runs through a shell, and either path
    // can contain a space (the same class of bug as the daemon spawn fix).
    const command = `${shQuote(process.execPath)} ${shQuote(binPath)}`;

    try {
      return await installHook(settingsPath, command);
    } catch (/** @type {any} */ err) {
      throw new CliError(1, err.message, 'state');
    }
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
 * How many verdict-`fix` comments still await a reply, and whether the reply
 * just made was to one. `nextStep` uses this, not `counts`, to decide whether
 * refresh is worth running: `counts` is keyed by status across every verdict,
 * so an all-`explain` batch would otherwise trigger a refresh that reports
 * `relocated: []` for nothing.
 * `replied` is the comment this reply answered.
 * @param {{verdict: string, status: string}[]} comments
 * @param {{verdict?: string}} [replied]
 * @returns {{outstanding: number, justFixed: boolean}}
 */
const fixCounts = (comments, replied) => ({
  outstanding: comments.filter((c) => c.verdict === 'fix' && c.status === 'sent').length,
  // Whether *this* reply touched code, not whether any fix was ever answered in
  // the session: a cumulative count made every later explain-only batch claim a
  // refresh was owed, which is the no-op this rule exists to avoid.
  justFixed: replied?.verdict === 'fix',
});

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
 * Live session state for a bare `cr`, or null when there is nothing to show:
 * not in a worktree, no session for it, or the session is closed. Deliberately
 * does not call `ensureServer`: a status glance must not start a daemon.
 * @param {string} cwd
 * @returns {Promise<Record<string, unknown>|null>}
 */
const liveState = async (cwd) => {
  const root = await toplevel(cwd).catch(() => null);
  if (root === null) return null;

  const session = (await loadState()).sessions[sessionKey(root)];
  if (!session || session.status !== 'open') return null;

  return {
    repo: root,
    note: session.note,
    base: session.base ?? '',
    pr: session.pr ?? '',
    unsent: session.comments.filter((/** @type {{status: string}} */ c) => c.status === 'open').length,
    counts: commentCounts(session.comments),
  };
};

/**
 * `resolvePr` is injectable so tests can drive the `--pr` wiring without a
 * real `gh` on PATH, the same seam `resolvePr` itself uses for `gh`.
 * `homedir` is injectable so `cr setup --global` can be exercised against a
 * throwaway directory instead of a developer's real home.
 * @param {{argv: string[], cwd: string, env?: NodeJS.ProcessEnv, resolvePr?: ResolvePr, homedir?: () => string}} input
 * @returns {Promise<{code: number, out: string}>}
 */
export const run = async ({
  argv, cwd, resolvePr = defaultResolvePr, homedir = os.homedir,
}) => {
  // A first, loose pass just to find the verb: only then do we know which
  // flags on this line are boolean, so a second pass can parse properly.
  const probeVerb = parseArgs(argv, booleanFlagNames()).verb;
  const { verb, flags, positional } = parseArgs(argv, booleanFlagNames(probeVerb));

  const asText = (/** @type {unknown} */ value) => (
    flags.json === true ? JSON.stringify(value, null, 2) : encode(/** @type {any} */ (value))
  );
  /**
   * @param {string} slug
   * @param {string} message
   * @returns {Record<string, unknown>}
   */
  const errorPayload = (slug, message) => {
    /** @type {Record<string, unknown>} */
    const payload = { error: { code: slug, message } };
    const step = flags['no-help'] === true ? undefined : nextStep('error', payload);
    return step === undefined ? payload : { ...payload, next_step: step };
  };
  /** @param {CliError} err */
  const fail = (err) => ({ code: err.code, out: asText(errorPayload(err.slug, err.message)) });

  // `help` is not a real handler: it is what a bare `cr`, or the literal
  // word `help`, resolves to (see parseArgs). It still has a VERBS entry, so
  // every check below (unknown flag, arity, positional) applies to it same
  // as any other verb: decision 13 was unmet here precisely because this
  // path used to return before reaching them.
  // A plain object literal, like `HANDLERS` and `VERBS`, resolves `Object.prototype`
  // members for a verb such as `constructor`, `toString` or `__proto__`'s own
  // string form: `hasOwn` is required so those crash cleanly as "unknown verb".
  const handler = Object.hasOwn(HANDLERS, verb) ? HANDLERS[verb] : undefined;
  if (verb !== 'help' && !handler) return fail(new CliError(1, `unknown verb "${verb}"`, 'usage'));

  if (verb === 'help') {
    if (flags.help === true) return { code: 0, out: USAGE };
  } else if (flags.help === true) {
    return { code: 0, out: verbHelp(verb) };
  }

  const unknown = unknownFlags(verb, flags);
  if (unknown.length > 0) {
    const named = unknown.map((f) => `--${f}`).join(', ');
    const help = verb === 'help' ? USAGE : verbHelp(verb);
    return { code: 2, out: `unknown ${unknown.length === 1 ? 'flag' : 'flags'} ${named}\n\n${help}` };
  }

  const arityMessage = checkArity(verb, flags);
  if (arityMessage) return fail(new CliError(1, arityMessage, 'usage'));

  if (positional.length > 0) {
    return fail(new CliError(1, `cr ${verb} takes no positional arguments, got "${positional[0]}"`, 'usage'));
  }

  if (verb === 'help') {
    const live = await liveState(cwd);
    if (live === null) return { code: 0, out: USAGE };
    if (flags['no-help'] === true) return { code: 0, out: asText(live) };
    const withHelp = { ...live, help: nextSteps(verb, live) };
    return { code: 0, out: asText({ ...withHelp, next_step: nextStep(verb, live) }) };
  }

  // Unreachable in practice: the hasOwn check above already failed any verb
  // without a handler. Narrows `handler` for tsc, which cannot see across
  // the two checks that every path reaching here has one.
  if (!handler) return fail(new CliError(1, `unknown verb "${verb}"`, 'usage'));

  try {
    // setup touches Claude Code's own settings, not the review server, so it
    // must not start a daemon as a side effect of installing a hook.
    const port = verb === 'setup' ? -1 : await ensureServer();
    const result = await handler({
      flags, cwd, port, resolvePr, homedir,
    });
    const payload = /** @type {Record<string, unknown>} */ (forDisplay(result));
    if (flags['no-help'] === true) return { code: 0, out: asText(payload) };
    const withHelp = { ...payload, help: nextSteps(verb, payload) };
    const step = nextStep(verb, payload);
    return { code: 0, out: asText(step === undefined ? withHelp : { ...withHelp, next_step: step }) };
  } catch (err) {
    const code = err instanceof CliError ? err.code : 1;
    const slug = err instanceof CliError ? err.slug : 'error';
    const message = err instanceof Error ? err.message : String(err);
    return { code, out: asText(errorPayload(slug, message)) };
  }
};

export const COMMANDS = HANDLERS;
