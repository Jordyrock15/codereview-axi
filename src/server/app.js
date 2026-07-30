import { toplevel } from '../diff/git.js';
import { buildSnapshot } from '../diff/snapshot.js';
import { mutateState } from '../state/store.js';
import { openOrReuse, closeSession, reapSessions } from '../state/sessions.js';
import { reanchor } from '../state/anchor.js';
import { StateError } from '../state/errors.js';
import { guard } from './security.js';
import { createHub } from './sse.js';
import { createRouter } from './router.js';

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

  /** @type {import('./router.js').Route[]} */
  const routes = [
    {
      method: 'POST',
      pattern: '/api/sessions',
      handler: async ({ req, body }) => {
        const verdict = guard({ headers: req.headers, url: req.url, port, session: /** @type {Session} */ ({ token: '' }) });
        if (verdict.ok === false && verdict.status === 403) throw new StateError(403, verdict.message);

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
        const session = await guarded(ctx);
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
        await guarded(ctx);
        const closedBy = ctx.body?.closedBy ?? 'agent';
        if (!['human', 'agent'].includes(closedBy)) throw new StateError(400, 'closedBy must be human or agent');

        const session = await mutateState((state) => closeSession(state.sessions[ctx.params.key], closedBy, now()));
        hub.publish(session.key, 'closed', { closedBy });
        return { body: publicSession(session) };
      },
    },
  ];

  return { handler: createRouter(routes), hub, routes, port };
};
