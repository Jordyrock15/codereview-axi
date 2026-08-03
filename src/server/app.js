import { toplevel, currentBranch } from '../diff/git.js';
import { buildSnapshot as defaultBuildSnapshot } from '../diff/snapshot.js';
import { mutateState, loadState } from '../state/store.js';
import {
  openOrReuse, closeSession, reapSessions, sessionKey, assertNoBaseConflict,
} from '../state/sessions.js';
import { reanchor } from '../state/anchor.js';
import { StateError } from '../state/errors.js';
import { guard, checkOrigin } from './security.js';
import { createHub } from './sse.js';
import { createRouter } from './router.js';
import {
  addComment, patchComment, markSent, applyReply, addFollowup, removeQueued, hasUndeliveredHuman, markDelivered, unsentCount,
} from '../state/comments.js';
import { takeLease, releaseLease } from './lease.js';
import { commentContext, expandContext } from '../diff/context.js';
import { shellHtml, assetResponse } from './ui.js';
import { shQuote } from '../shell.js';

/**
 * @typedef {import('../types.js').Session} Session
 * @typedef {import('../types.js').SnapshotFile} SnapshotFile
 */

/**
 * `mergeBase` (via `buildSnapshot`) discriminates a missing ref from unrelated
 * histories, and `git()` itself tags a diff that overran the buffer; without
 * this the route mapped all of it, along with everything else, to a bare 500
 * internal error.
 *
 * `base` reaches this message unsanitised: for a `--pr` session it is a PR's
 * base branch name, read via `gh`, and so no more trustworthy than the diff
 * itself. `shQuote` is what keeps the suggested `git fetch` pasteable rather
 * than executable.
 * @param {unknown} err
 * @param {string|undefined} base
 * @returns {unknown} A `StateError` when the failure is base-related, the original error otherwise.
 */
const translateBaseFailure = (err, base) => {
  if (!(err instanceof Error)) return err;
  const reason = /** @type {any} */ (err).crReason;

  // Independent of whether a base is even in play: a plain working diff can
  // overrun the buffer just as easily as a PR's.
  if (reason === 'max-buffer') {
    const hint = base !== undefined
      ? ` Try a narrower base, for example a more recent commit than ${shQuote(base)}.`
      : ' Try reviewing a narrower diff.';
    return new StateError(413, `${err.message}.${hint}`);
  }

  if (base === undefined) return err;
  if (reason === 'missing-ref') {
    return new StateError(400, `${err.message}. For a pull request this usually means the base branch has not been fetched, try git fetch origin ${shQuote(base)}.`);
  }
  if (reason === 'unrelated-history' || reason === 'invalid-ref') return new StateError(400, err.message);
  return err;
};

/**
 * Metadata only. Hunks stay out of the agent's context.
 * @param {SnapshotFile} file
 */
const fileMeta = ({ path, status, added, removed, tags, binary }) => ({ path, status, added, removed, tags, binary });

/**
 * @param {Session} session
 */
const publicSession = ({ token, ...rest }) => rest;

/**
 * @param {{port: number, now?: () => number, hub?: ReturnType<typeof createHub>, buildSnapshot?: typeof defaultBuildSnapshot, onIdle?: () => void}} options
 */
export const createApp = ({
  port, now = () => Date.now(), hub = createHub(), buildSnapshot = defaultBuildSnapshot,
  onIdle = () => {},
}) => {
  /**
   * Loads a session and applies the full guard. Throws on any failure.
   * @param {any} ctx
   * @returns {Promise<Session>}
   */
  const guarded = async (ctx) => mutateState((state) => {
    const session = state.sessions[ctx.params.key] ?? null;
    const verdict = guard({ headers: ctx.req.headers, url: ctx.req.url, port, session });
    if (!verdict.ok) throw new StateError(verdict.status, verdict.message);
    return /** @type {Session} */ (session);
  });

  /**
   * A closed session must stay readable (the browser shows its final state)
   * but must not accept further mutation.
   * @param {Session} session
   * @returns {Session}
   */
  const requireOpen = (session) => {
    if (session.status !== 'open') throw new StateError(409, 'session is closed');
    return session;
  };

  /**
   * Only files in the current diff may be read. Without this, a caller holding
   * the token can walk out of the repo with a relative path such as ../secret.
   * @param {Session} session
   * @param {unknown} file
   * @returns {string}
   */
  const requireDiffFile = (session, file) => {
    const path = String(file ?? '');
    if (path === '') throw new StateError(400, 'file is required');
    if (!session.snapshot.files.some((entry) => entry.path === path)) {
      throw new StateError(400, `${path} is not a file in this diff`);
    }
    return path;
  };

  /**
   * A quote must carry exactly the lines its range claims, or re-anchoring will
   * never find it again. Content is not compared: expanded-context lines
   * legitimately sit outside the snapshot, and a blank line is a legitimate
   * quote too, `''.split('\n').length` is already 1, the right count for a
   * one-line range. This can no longer tell a genuinely blank line apart from
   * a missing quote on a one-line range; that trade is accepted because the
   * defect this guards against (an empty quote from unmatched rows) is fixed
   * at source now that the quote is read from the rendered rows.
   * @param {any} body
   * @returns {void}
   */
  const requireQuoteShape = (body) => {
    if ((body?.scope ?? 'line') !== 'line') return;

    const start = Number(body?.startLine);
    const end = Number(body?.endLine ?? body?.startLine);
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new StateError(400, 'startLine and endLine must be integers');

    const expected = end - start + 1;
    const supplied = String(body?.quote ?? '').split('\n').length;
    if (supplied !== expected) {
      throw new StateError(400, `quote has ${supplied} line(s) but the range covers ${expected}`);
    }
  };

  const SCOPES = ['line', 'file', 'session'];
  const SIDES = ['old', 'new'];

  /**
   * Both fields are persisted unvalidated today and handed straight to the
   * agent; neither reaches a dangerous sink (the code only ever tests
   * `=== 'new'` or `=== 'session'`), but an arbitrary string still has no
   * business surviving into stored state.
   * @param {any} body
   * @returns {void}
   */
  const requireCommentShape = (body) => {
    const scope = body?.scope ?? 'line';
    if (!SCOPES.includes(scope)) throw new StateError(400, `scope must be one of ${SCOPES.join(', ')}`);
    if (scope === 'line' && body?.side !== undefined && !SIDES.includes(body.side)) {
      throw new StateError(400, `side must be one of ${SIDES.join(', ')}`);
    }
  };

  /** @type {Map<string, Set<() => void>>} */
  const waiters = new Map();

  /** @param {string} key */
  const wake = (key) => {
    for (const resolve of waiters.get(key) ?? []) resolve();
  };

  /**
   * @param {string} key
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  const waitForWake = (key, timeoutMs) => new Promise((resolve) => {
    const set = waiters.get(key) ?? new Set();
    waiters.set(key, set);

    const timer = setTimeout(() => { set.delete(done); resolve(); }, timeoutMs);
    const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
    set.add(done);
  });

  /**
   * Re-reads the state when the timer fires rather than trusting the check that
   * scheduled it. `cr close` followed straight away by `cr open` is ordinary
   * use, and deciding at schedule time would shoot the daemon out from under
   * the session that had just opened. Every session in the file is considered,
   * not just this repo's: one daemon serves them all, so another repo's open
   * review has to keep it alive.
   * @returns {void}
   */
  const scheduleIdleStop = () => {
    const timer = setTimeout(async () => {
      const state = await loadState();
      if (!Object.values(state.sessions).some((session) => session.status === 'open')) onIdle();
    }, 250);
    // Never the reason the process stays up.
    timer.unref();
  };

  /** @type {import('./router.js').Route[]} */
  const routes = [
    {
      method: 'POST',
      pattern: '/api/sessions',
      handler: async ({ req, body }) => {
        const verdict = checkOrigin({ headers: req.headers, port });
        if (!verdict.ok) throw new StateError(verdict.status, verdict.message);

        const requested = String(body?.repo ?? process.cwd());
        const root = await toplevel(requested);
        if (root === null) throw new StateError(400, `${requested} is not inside a git worktree`);

        const base = typeof body?.base === 'string' ? body.base : undefined;
        const pr = typeof body?.pr === 'number' && Number.isInteger(body.pr) ? body.pr : undefined;
        if (pr !== undefined && base === undefined) {
          throw new StateError(400, 'a PR session needs a base as well, none was given');
        }
        const at = now();
        const key = sessionKey(root);

        // A conflict must win over an empty-diff 422, so it is checked here,
        // before the snapshot is built, on a throwaway state copy (never
        // persisted; the mutating pass below reaps and rechecks the real
        // state, so a race here just costs a wasted snapshot, not a bad open).
        const preState = await loadState();
        reapSessions(preState, at);
        assertNoBaseConflict(preState.sessions[key], base, pr);

        let built;
        try {
          built = await buildSnapshot(root, base);
        } catch (err) {
          throw translateBaseFailure(err, base);
        }

        // Read alongside the snapshot so the tab has a short, stable label. The
        // note cannot serve as one: --say overwrites it every round, so the
        // header used to be whatever the agent last said.
        const branch = await currentBranch(root);

        // Building the snapshot is real git work (a diff, a merge-base, every
        // untracked file read); running it inside mutateState would serialise
        // it behind every other route, including the long poll's drain. But
        // the conflict must be decided last, inside the mutex: a session that
        // opened while this snapshot was building still wins over an
        // empty-diff 422, which the fast pre-check above cannot guarantee on
        // its own since it runs before this await, not after it.
        const { session, reused, snapshot } = await mutateState((state) => {
          reapSessions(state, at);
          assertNoBaseConflict(state.sessions[key], base, pr);

          if (built.files.length === 0) {
            throw new StateError(422, base !== undefined
              ? `nothing to review, the branch has no changes against ${base}`
              : 'nothing to review, the working tree is clean');
          }

          const result = openOrReuse(state, {
            repo: root, note: String(body?.note ?? ''), snapshot: built, port, now: at, base, pr,
          });
          // Set outside openOrReuse so a reused session picks up a branch
          // switch since it was opened.
          result.session.branch = branch;
          // A reused session's threads are anchored against the old snapshot;
          // without this a second `cr open` leaves them silently pointing at
          // whatever now occupies their old line numbers.
          if (result.reused) reanchor(result.session, built);
          return { ...result, snapshot: built };
        });

        return {
          status: 201,
          body: {
            key: session.key,
            token: session.token,
            url: session.url,
            reused,
            note: session.note,
            base: session.base,
            pr: session.pr,
            files: snapshot.files.map(fileMeta),
            totals: snapshot.totals,
            comments: session.comments.map(({ id, file, startLine, endLine, status, verdict: v }) => (
              { id, file, startLine, endLine, status, verdict: v }
            )),
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/api/sessions/:key',
      handler: async (ctx) => ({ body: publicSession(await guarded(ctx)) }),
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:key/refresh',
      handler: async (ctx) => {
        const session = requireOpen(await guarded(ctx));
        const base = session.base ?? undefined;
        let snapshot;
        try {
          snapshot = await buildSnapshot(session.repo, base);
        } catch (err) {
          throw translateBaseFailure(err, base);
        }
        const at = now();

        const result = await mutateState((state) => {
          const live = state.sessions[ctx.params.key];
          live.snapshot = snapshot;
          live.snapshotAt = new Date(at).toISOString();
          live.updatedAt = new Date(at).toISOString();
          return reanchor(live, snapshot);
        });

        hub.publish(session.key, 'refreshed', { totals: snapshot.totals, ...result });
        return { body: { totals: snapshot.totals, ...result } };
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:key/close',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
        const closedBy = ctx.body?.closedBy ?? 'agent';
        if (!['human', 'agent'].includes(closedBy)) throw new StateError(400, 'closedBy must be human or agent');

        const session = await mutateState((state) => closeSession(state.sessions[ctx.params.key], closedBy, now()));
        hub.publish(session.key, 'closed', { closedBy });

        // With nothing open anywhere, the daemon has nothing left to serve.
        // Neither `cr close` nor the browser's Done used to stop it, so every
        // finished review left a process behind and the port range filled up.
        scheduleIdleStop();
        wake(session.key);
        return { body: publicSession(session) };
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:key/comments',
      handler: async (ctx) => {
        const session = requireOpen(await guarded(ctx));
        requireCommentShape(ctx.body ?? {});
        // A traversing path here would be read back later by the pending poll.
        if ((ctx.body?.scope ?? 'line') !== 'session') requireDiffFile(session, ctx.body?.file);
        requireQuoteShape(ctx.body ?? {});

        const comment = await mutateState((state) => (
          addComment(state.sessions[ctx.params.key], ctx.body ?? {}, now())
        ));
        hub.publish(ctx.params.key, 'comment', comment);
        return { status: 201, body: comment };
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/sessions/:key/comments/:id',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
        // Quote editing is not supported: patchComment has no branch for it, so
        // a quote here would validate and then be silently dropped. No guard.
        const comment = await mutateState((state) => (
          patchComment(state.sessions[ctx.params.key], Number(ctx.params.id), ctx.body ?? {}, now())
        ));
        hub.publish(ctx.params.key, 'comment', comment);
        return { body: comment };
      },
    },
    {
      // No route existed for this before; the closest prior art is /note and
      // /view, which also mutate a session field directly here rather than
      // through src/state/comments.js. Scoped to open only: once a comment is
      // sent the agent may already be acting on it, and pulling it back here
      // would silently desync the session from what it was told. A comment
      // re-queued by a follow-up is not deleted outright: see removeQueued.
      method: 'DELETE',
      pattern: '/api/sessions/:key/comments/:id',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
        const id = Number(ctx.params.id);
        if (!Number.isInteger(id)) throw new StateError(400, 'id must be an integer');

        const result = await mutateState((state) => removeQueued(state.sessions[ctx.params.key], id, now()));

        hub.publish(ctx.params.key, 'comment', result.removed ? { id, removed: true } : result.comment);
        return { body: result.removed ? { id, removed: true } : result.comment };
      },
    },
    {
      // Replaces Reopen: new text rather than the same body resent, and
      // queued like any other unsent comment so the human can check it (or
      // Remove it) before it reaches the agent.
      method: 'POST',
      pattern: '/api/sessions/:key/comments/:id/followup',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
        const id = Number(ctx.params.id);
        if (!Number.isInteger(id)) throw new StateError(400, 'id must be an integer');

        const comment = await mutateState((state) => (
          addFollowup(state.sessions[ctx.params.key], id, String(ctx.body?.body ?? ''), now())
        ));
        hub.publish(ctx.params.key, 'comment', comment);
        return { status: 201, body: comment };
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:key/send',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
        const sent = await mutateState((state) => markSent(state.sessions[ctx.params.key], now()));

        if (sent.length > 0) {
          hub.publish(ctx.params.key, 'sent', { ids: sent.map((c) => c.id) });
          wake(ctx.params.key);
        }
        return { body: { sent: sent.length } };
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:key/replies',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
        const id = Number(ctx.body?.id);
        if (!Number.isInteger(id)) throw new StateError(400, 'id must be an integer');

        const comment = await mutateState((state) => applyReply(
          state.sessions[ctx.params.key],
          id,
          { status: String(ctx.body?.status ?? ''), body: String(ctx.body?.body ?? '') },
          now(),
        ));

        hub.publish(ctx.params.key, 'comment', comment);
        return { body: comment };
      },
    },
    {
      method: 'GET',
      pattern: '/api/sessions/:key/pending',
      handler: async (ctx) => {
        const session = await guarded(ctx);
        const holder = Number(ctx.query.get('holder') ?? 0);
        const requestedS = Number(ctx.query.get('timeout') ?? 300);
        // Node's global fetch aborts at 300s (UND_ERR_HEADERS_TIMEOUT). Holding for
        // the full requested duration then doing more work before responding runs
        // past that, so the client sees a transport failure instead of an answer.
        const timeoutMs = Math.max(1000, Math.min(requestedS, 900) * 1000 - 5000);

        await mutateState((state) => takeLease(state.sessions[ctx.params.key], holder, now()));

        try {
          // deliveredAt is what makes delivery at-most-once, now per message
          // rather than per comment: a follow-up on a comment already
          // delivered once must still surface, and a re-poll after a crash
          // must not replay a message this round already stamped.
          const peek = () => mutateState((state) => {
            const live = state.sessions[ctx.params.key];
            return { live, sent: live.comments.filter(hasUndeliveredHuman) };
          });

          let { live, sent } = await peek();
          if (sent.length === 0 && live.status === 'open') {
            await waitForWake(ctx.params.key, timeoutMs);
            ({ live, sent } = await peek());
          }

          const withContext = await Promise.all(sent.map(async (comment) => ({
            ...comment,
            context: comment.scope === 'line' && comment.file !== null
              ? await commentContext(live.repo, comment.file, comment.startLine ?? 1, comment.endLine ?? 1, 8)
              : { before: [], after: [] },
          })));

          // Stamp only once the payload is built. Stamping first meant every
          // file read for context happened after the comments were already
          // persisted as delivered, so a poll that died in that window
          // consumed them for good: the browser showed them sent forever and
          // no later `cr wait` could ever surface them again. Re-read inside
          // the mutation rather than stamping the objects captured above, so a
          // comment edited during the reads is not marked for a payload that
          // no longer describes it.
          const delivering = new Set(withContext.map((comment) => comment.id));
          await mutateState((state) => {
            const at = new Date(now()).toISOString();
            for (const comment of state.sessions[ctx.params.key].comments) {
              if (delivering.has(comment.id) && hasUndeliveredHuman(comment)) markDelivered(comment, at);
            }
          });

          return {
            body: {
              comments: withContext,
              closed: live.status === 'closed',
              closedBy: live.closedBy,
              unsent: unsentCount(live),
            },
          };
        } finally {
          await mutateState((state) => releaseLease(state.sessions[ctx.params.key], holder));
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/sessions/:key/stream',
      handler: async (ctx) => {
        await guarded(ctx);
        const off = hub.subscribe(ctx.params.key, ctx.res);
        ctx.req.on('close', off);
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/sessions/:key/note',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
        const note = String(ctx.body?.note ?? '');
        const session = await mutateState((state) => {
          const live = state.sessions[ctx.params.key];
          live.note = note;
          live.updatedAt = new Date(now()).toISOString();
          return live;
        });
        hub.publish(ctx.params.key, 'note', { note });
        return { body: { note: session.note } };
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/sessions/:key/view',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
        const view = String(ctx.body?.view ?? '');
        if (!['unified', 'split'].includes(view)) throw new StateError(400, 'view must be unified or split');

        const session = await mutateState((state) => {
          const live = state.sessions[ctx.params.key];
          live.view = /** @type {'unified'|'split'} */ (view);
          live.updatedAt = new Date(now()).toISOString();
          return live;
        });

        hub.publish(ctx.params.key, 'view', { view: session.view });
        return { body: { view: session.view } };
      },
    },
    {
      method: 'GET',
      pattern: '/session/:key',
      handler: async ({ res, params }) => {
        // No token check here: the page fetches its own data with the token
        // from the query string. But an unknown key must not render at all.
        const state = await loadState();
        if (!state.sessions[params.key]) throw new StateError(404, 'no such session');

        const html = shellHtml(params.key);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
          'X-Frame-Options': 'DENY',
          // The session token lives in this URL's own query string; no-referrer
          // is the belt to the CSP's braces so it never leaks via a Referer header.
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(html);
      },
    },
    {
      method: 'GET',
      pattern: '/assets/:name',
      handler: async ({ res, params }) => {
        const asset = await assetResponse(params.name);
        if (asset.body === null) throw new StateError(404, 'not found');
        res.writeHead(200, {
          'Content-Type': asset.type,
          'Content-Length': Buffer.byteLength(asset.body),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(asset.body);
      },
    },
    {
      method: 'GET',
      pattern: '/api/sessions/:key/context',
      handler: async (ctx) => {
        const session = await guarded(ctx);
        const file = requireDiffFile(session, ctx.query.get('file'));

        const from = Number(ctx.query.get('from') ?? 1);
        const to = Number(ctx.query.get('to') ?? from);
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
          throw new StateError(400, 'from and to must be numbers');
        }
        return { body: await expandContext(session.repo, file, from, to) };
      },
    },
  ];

  return { handler: createRouter(routes), hub, routes, port };
};
