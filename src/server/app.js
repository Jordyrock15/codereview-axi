import { toplevel } from '../diff/git.js';
import { buildSnapshot } from '../diff/snapshot.js';
import { mutateState } from '../state/store.js';
import { openOrReuse, closeSession, reapSessions } from '../state/sessions.js';
import { reanchor } from '../state/anchor.js';
import { StateError } from '../state/errors.js';
import { guard, checkOrigin } from './security.js';
import { createHub } from './sse.js';
import { createRouter } from './router.js';
import { addComment, patchComment, markSent, applyReply, unsentCount } from '../state/comments.js';
import { takeLease, releaseLease } from './lease.js';
import { commentContext } from '../diff/context.js';

/**
 * @typedef {import('../types.js').Session} Session
 * @typedef {import('../types.js').SnapshotFile} SnapshotFile
 */

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
 * @param {{port: number, now?: () => number, hub?: ReturnType<typeof createHub>}} options
 */
export const createApp = ({ port, now = () => Date.now(), hub = createHub() }) => {
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

        const snapshot = await buildSnapshot(root);
        if (snapshot.files.length === 0) throw new StateError(422, 'nothing to review, the working tree is clean');

        const at = now();
        const { session, reused } = await mutateState((state) => {
          reapSessions(state, at);
          return openOrReuse(state, { repo: root, note: String(body?.note ?? ''), snapshot, port, now: at });
        });

        return {
          status: 201,
          body: {
            key: session.key,
            token: session.token,
            url: session.url,
            reused,
            note: session.note,
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
        const snapshot = await buildSnapshot(session.repo);
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
        wake(session.key);
        return { body: publicSession(session) };
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:key/comments',
      handler: async (ctx) => {
        requireOpen(await guarded(ctx));
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
        await guarded(ctx);
        const comment = await mutateState((state) => (
          patchComment(state.sessions[ctx.params.key], Number(ctx.params.id), ctx.body ?? {}, now())
        ));
        hub.publish(ctx.params.key, 'comment', comment);
        return { body: comment };
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
        const timeoutMs = Math.min(Number(ctx.query.get('timeout') ?? 300), 900) * 1000;

        await mutateState((state) => takeLease(state.sessions[ctx.params.key], holder, now()));

        try {
          // deliveredAt is what makes delivery at-most-once: a re-poll after a
          // crash sees an empty queue rather than replaying the same work.
          const drain = () => mutateState((state) => {
            const live = state.sessions[ctx.params.key];
            const sent = live.comments.filter((c) => c.status === 'sent' && !c.deliveredAt);
            const at = new Date(now()).toISOString();
            for (const comment of sent) comment.deliveredAt = at;
            return { live, sent };
          });

          let { live, sent } = await drain();
          if (sent.length === 0 && live.status === 'open') {
            await waitForWake(ctx.params.key, timeoutMs);
            ({ live, sent } = await drain());
          }

          const withContext = await Promise.all(sent.map(async (comment) => ({
            ...comment,
            context: comment.scope === 'line' && comment.file !== null
              ? await commentContext(live.repo, comment.file, comment.startLine ?? 1, comment.endLine ?? 1, 8)
              : { before: [], after: [] },
          })));

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
  ];

  return { handler: createRouter(routes), hub, routes, port };
};
