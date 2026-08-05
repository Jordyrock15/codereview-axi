import { JSDOM } from 'jsdom';
import { shellHtml } from '../../src/server/ui.js';

/**
 * @typedef {import('../../src/types.js').Session} Session
 * @typedef {import('../../src/types.js').SnapshotFile} SnapshotFile
 * @typedef {import('../../src/types.js').Comment} Comment
 * @typedef {import('../../src/types.js').Message} Message
 * @typedef {import('../../src/types.js').Hunk} Hunk
 * @typedef {import('../../src/types.js').DiffLine} DiffLine
 */

/**
 * One route result, before it becomes a `Response`.
 * @interface RouteResult
 * @typedef {Object} RouteResult
 * @property {number} status — HTTP status.
 * @property {any} json — The body.
 */

/**
 * One recorded request.
 * @interface RecordedRequest
 * @typedef {Object} RecordedRequest
 * @property {string} method — HTTP method.
 * @property {string} path — Path after `/api/sessions/<key>`, query string included.
 * @property {any} body — Parsed request body, null when there was none.
 * @property {Record<string, string>} headers — Headers app.js sent, empty for a stream request.
 */

/**
 * A mounted app, with the handles a test drives it through.
 * @interface Mounted
 * @typedef {Object} Mounted
 * @property {import('jsdom').DOMWindow} window — The jsdom window.
 * @property {Document} document — Its document.
 * @property {RecordedRequest[]} requests — Every request app.js made, in order.
 * @property {() => Session} session — The fixture as the fake server now holds it, token included, unlike the body the session route serves.
 * @property {(name: string) => Promise<void>} emit — Fires a stream event and waits for the reload it triggers, or does nothing once app.js closed the stream.
 * @property {(answer: boolean) => void} confirmNext — What the next `window.confirm` returns.
 * @property {(next: Session) => void} setSession — Replaces the served session.
 * @property {() => void} teardown — Clears timers, hands the globals back and closes the window.
 */

/**
 * One mount's place in the global-install stack.
 * @interface MountFrame
 * @typedef {Object} MountFrame
 * @property {import('jsdom').DOMWindow} window — The window this mount owns.
 * @property {Record<string, unknown>} saved — The globals this mount found in place.
 * @property {Record<string, unknown>} installed — The globals this mount put in their place.
 */

let mounts = 0;

/** @type {MountFrame[]} */
const stack = [];

/** The globals the mount at the bottom of the stack displaced. @type {Record<string, unknown>|null} */
let pristine = null;

/**
 * The fetch a torn-down mount leaves behind. It never settles, so an async
 * click handler still in flight stops at its next `await` instead of running on
 * against a dead window with the real `fetch` and a relative URL.
 * @returns {Promise<Response>}
 */
const inertFetch = () => /** @type {Promise<Response>} */ (new Promise(() => {}));

/**
 * Every method and path pair app.js asks for. A route override key that matches
 * none of these is a typo, and an unchecked typo falls through to the happy
 * path, so the test asserts a normal render and still passes.
 * @type {RegExp[]}
 */
const ROUTE_KEYS = [
  /^GET $/,
  /^GET \/context$/,
  /^POST \/comments$/,
  /^POST \/comments\/\d+\/followup$/,
  /^POST \/send$/,
  /^POST \/close$/,
  /^PATCH \/view$/,
  /^PATCH \/comments\/\d+$/,
  /^DELETE \/comments\/\d+$/,
];

/** Literal forms, so a copied line passes `checkRouteKeys` as it stands. */
const ROUTE_KEY_HELP = [
  '"GET " (the session route, note the trailing space)',
  '"GET /context"',
  '"POST /comments"',
  '"POST /comments/1/followup"',
  '"POST /send"',
  '"POST /close"',
  '"PATCH /view"',
  '"PATCH /comments/1"',
  '"DELETE /comments/1"',
].join(', ');

/**
 * @param {Record<string, unknown>} routes
 * @returns {void}
 */
const checkRouteKeys = (routes) => {
  for (const key of Object.keys(routes)) {
    if (ROUTE_KEYS.some((pattern) => pattern.test(key))) continue;
    throw new Error(`Unknown route override key "${key}". Use one of: ${ROUTE_KEY_HELP}.`);
  }
};

/**
 * Drops a mount out of the stack and hands the globals back to whichever mount
 * is on top now, or to the pristine set once the stack empties. `fetch` is the
 * one exception: it stays inert rather than real, so a handler still in flight
 * cannot reach the network from a dead window. No test needs a live `fetch`.
 * @param {MountFrame} frame
 * @returns {void}
 */
const unstack = (frame) => {
  const wasTop = stack[stack.length - 1] === frame;
  const at = stack.indexOf(frame);
  if (at !== -1) stack.splice(at, 1);
  if (!wasTop) return;

  const top = stack[stack.length - 1];
  Object.assign(globalThis, top ? top.installed : { ...pristine, fetch: inertFetch });
};

/**
 * The real route strips the token before it answers, so the fake one must too,
 * or a test learns the wrong shape.
 * @param {Session} session
 * @returns {Omit<Session, 'token'>}
 */
const withoutToken = ({ token, ...rest }) => rest;

/**
 * @param {Partial<DiffLine>} overrides
 * @returns {DiffLine}
 */
export const lineFixture = (overrides = {}) => ({
  kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1, ...overrides,
});

/**
 * @param {Partial<Hunk>} overrides
 * @returns {Hunk}
 */
export const hunkFixture = (overrides = {}) => ({
  oldStart: 10,
  oldLines: 3,
  newStart: 10,
  newLines: 3,
  header: 'const api = () => {',
  lines: [
    lineFixture({ kind: 'context', text: 'const a = 1;', oldLine: 10, newLine: 10 }),
    lineFixture({ kind: 'del', text: 'const b = 2;', oldLine: 11, newLine: null }),
    lineFixture({ kind: 'add', text: 'const b = 3;', oldLine: null, newLine: 11 }),
  ],
  ...overrides,
});

/**
 * @param {Partial<SnapshotFile>} overrides
 * @returns {SnapshotFile}
 */
export const fileFixture = (overrides = {}) => ({
  path: 'src/a.js',
  oldPath: null,
  status: 'modified',
  binary: false,
  added: 1,
  removed: 1,
  hunks: [hunkFixture()],
  tags: [],
  ...overrides,
});

/**
 * @param {Partial<Comment>} overrides
 * @returns {Comment}
 */
export const commentFixture = (overrides = {}) => ({
  id: 1,
  scope: 'line',
  file: 'src/a.js',
  side: 'new',
  startLine: 11,
  endLine: 11,
  quote: 'const b = 3;',
  body: 'name this',
  verdict: 'fix',
  status: 'open',
  replies: [],
  deliveredAt: null,
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  ...overrides,
});

/**
 * @param {Partial<Session>} overrides
 * @returns {Session}
 */
export const sessionFixture = (overrides = {}) => ({
  key: 'abc123',
  token: 'tok',
  repo: '/tmp/repo',
  base: 'main',
  pr: null,
  branch: 'feat/x',
  url: 'http://127.0.0.1:4390/s/abc123?t=tok',
  status: 'open',
  closedBy: null,
  note: 'two comments answered',
  snapshot: { files: [fileFixture()], totals: { files: 1, added: 1, removed: 1 } },
  snapshotAt: '2026-08-04T10:00:00.000Z',
  comments: [],
  chat: [],
  lease: null,
  view: 'unified',
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  ...overrides,
});

/**
 * A hunk with four plain context lines, so a range can span several rows
 * without a deletion or an addition complicating the line numbers.
 * @returns {Session}
 */
export const plainSession = () => sessionFixture({
  snapshot: {
    files: [fileFixture({
      hunks: [hunkFixture({
        lines: [10, 11, 12, 13].map((n) => lineFixture({ text: `line ${n};`, oldLine: n, newLine: n })),
      })],
    })],
    totals: { files: 1, added: 0, removed: 0 },
  },
});

/**
 * Two hunks with a gap between them, so a shift-click from one into the other
 * crosses a hunk boundary and the selection must restart.
 * @returns {Session}
 */
export const twoHunkSession = () => sessionFixture({
  snapshot: {
    files: [fileFixture({
      hunks: [
        hunkFixture({
          oldStart: 10, oldLines: 2, newStart: 10, newLines: 2,
          lines: [10, 11].map((n) => lineFixture({ text: `line ${n};`, oldLine: n, newLine: n })),
        }),
        hunkFixture({
          oldStart: 30, oldLines: 2, newStart: 30, newLines: 2,
          lines: [30, 31].map((n) => lineFixture({ text: `line ${n};`, oldLine: n, newLine: n })),
        }),
      ],
    })],
    totals: { files: 1, added: 0, removed: 0 },
  },
});

/**
 * A split-view session whose hunk holds one replaced line and one bare
 * addition, so one row has a line on both sides and the next has a blank old
 * gutter.
 * @returns {Session}
 */
export const splitSession = () => sessionFixture({
  view: 'split',
  snapshot: {
    files: [fileFixture({
      hunks: [hunkFixture({
        lines: [
          lineFixture({ kind: 'context', text: 'line 10;', oldLine: 10, newLine: 10 }),
          lineFixture({ kind: 'del', text: 'was 11;', oldLine: 11, newLine: null }),
          lineFixture({ kind: 'add', text: 'now 11;', oldLine: null, newLine: 11 }),
          lineFixture({ kind: 'add', text: 'new 12;', oldLine: null, newLine: 12 }),
        ],
      })],
    })],
    totals: { files: 1, added: 2, removed: 1 },
  },
});

/**
 * Waits one macrotask, which is all a click handler needs to run its awaits to
 * the end.
 * @returns {Promise<void>}
 */
export const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Mounts app.js against a jsdom page built from the real shell HTML, with the
 * network faked. Resolves once app.js's first render is done: app.js ends in a
 * top-level await, so the import settles after `load()` ran.
 * @param {{session?: Session, key?: string, token?: string, routes?: Record<string, (body: any) => RouteResult>}} [options]
 * @returns {Promise<Mounted>}
 */
export const mountApp = async (options = {}) => {
  const key = options.key ?? 'abc123';
  const token = options.token ?? 'tok';
  const routes = options.routes ?? {};
  checkRouteKeys(routes);
  let served = options.session ?? sessionFixture({ key });

  const dom = new JSDOM(shellHtml(key), { url: `http://127.0.0.1:4390/s/${key}?t=${token}` });
  const { window } = dom;

  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {Record<string, ((event: any) => void)[]>} */
  const streamHandlers = {};
  let confirmAnswer = true;
  let streamClosed = false;
  /** @type {Set<NodeJS.Timeout>} */
  const timers = new Set();

  /**
   * @param {string} path
   * @param {any} body
   * @returns {RouteResult}
   */
  const route = (path, body) => {
    const [bare] = path.split('?');
    const comments = served.comments;

    if (bare === '') return { status: 200, json: withoutToken(served) };

    if (bare === '/comments') {
      const id = comments.reduce((top, c) => Math.max(top, c.id), 0) + 1;
      served = { ...served, comments: [...comments, commentFixture({ ...body, id, status: 'open' })] };
      return { status: 200, json: { id } };
    }

    if (bare === '/send') {
      served = {
        ...served,
        comments: comments.map((c) => (c.status === 'open' ? { ...c, status: 'sent' } : c)),
      };
      return { status: 200, json: { sent: 1 } };
    }

    if (bare === '/close') {
      served = { ...served, status: 'closed', closedBy: 'human' };
      return { status: 200, json: { closed: true } };
    }

    if (bare === '/view') {
      served = { ...served, view: body.view };
      return { status: 200, json: { view: body.view } };
    }

    if (bare === '/context') {
      const from = Number(new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('from'));
      return { status: 200, json: { from, lines: ['const above = 1;', 'const above2 = 2;'] } };
    }

    const followup = bare.match(/^\/comments\/(\d+)\/followup$/);
    if (followup) {
      const id = Number(followup[1]);
      /** @type {Message} */
      const reply = { role: 'human', body: body.body, status: null, at: '', deliveredAt: null };
      served = {
        ...served,
        comments: comments.map((c) => (c.id === id
          ? { ...c, status: 'open', replies: [...c.replies, reply] }
          : c)),
      };
      return { status: 200, json: { id } };
    }

    const one = bare.match(/^\/comments\/(\d+)$/);
    if (one) {
      const id = Number(one[1]);
      served = body === null
        ? { ...served, comments: comments.filter((c) => c.id !== id) }
        : { ...served, comments: comments.map((c) => (c.id === id ? { ...c, ...body } : c)) };
      return { status: 200, json: { id } };
    }

    return { status: 404, json: { error: `no fake route for ${bare}` } };
  };

  /**
   * @param {string} url
   * @param {{method?: string, body?: string, headers?: Record<string, string>}} [init]
   * @returns {Promise<Response>}
   */
  const fakeFetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(`/api/sessions/${key}`, '');
    const body = init.body === undefined ? null : JSON.parse(init.body);
    requests.push({ method, path, body, headers: { ...init.headers } });

    const override = routes[`${method} ${path.split('?')[0]}`];
    const result = override ? override(body) : route(path, method === 'DELETE' ? null : body);
    return new Response(JSON.stringify(result.json), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  class FakeEventSource {
    /** @param {string} url */
    constructor(url) {
      requests.push({ method: 'STREAM', path: url, body: null, headers: {} });
    }

    /**
     * @param {string} name
     * @param {(event: any) => void} handler
     * @returns {void}
     */
    addEventListener(name, handler) {
      if (streamClosed) return;
      streamHandlers[name] = [...(streamHandlers[name] ?? []), handler];
    }

    /** @returns {void} */
    close() {
      streamClosed = true;
      for (const name of Object.keys(streamHandlers)) delete streamHandlers[name];
    }
  }

  const realSetTimeout = globalThis.setTimeout;
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    setTimeout: realSetTimeout,
  };

  window.Element.prototype.scrollIntoView = () => {};
  window.confirm = () => confirmAnswer;
  window.matchMedia = (/** @type {string} */ query) => /** @type {MediaQueryList} */ ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    addListener: () => {}, removeListener: () => {},
  });

  /**
   * Recorded so teardown can clear them: the overlay's hide timer outlives a
   * test and would otherwise keep the event loop alive after the window closed.
   * @param {(...args: any[]) => void} fn
   * @param {number} [ms]
   * @param {any[]} args
   * @returns {NodeJS.Timeout}
   */
  const recordedSetTimeout = (fn, ms, ...args) => {
    const id = realSetTimeout(fn, ms, ...args);
    timers.add(id);
    return id;
  };

  const installed = {
    document: window.document,
    window,
    location: window.location,
    fetch: fakeFetch,
    EventSource: FakeEventSource,
    setTimeout: recordedSetTimeout,
  };

  /** @type {MountFrame} */
  const frame = { window, saved, installed };
  if (stack.length === 0) pristine = saved;
  Object.assign(globalThis, installed);
  stack.push(frame);

  const clear = () => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  };

  mounts += 1;
  const module = new URL('../../src/server/public/app.js', import.meta.url);
  try {
    await import(`${module.href}?n=${mounts}`);
  } catch (err) {
    clear();
    unstack(frame);
    window.close();
    throw err;
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  const emit = async (name) => {
    if (!streamClosed) {
      for (const handler of streamHandlers[name] ?? []) handler({ type: name });
    }
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  };

  return {
    window,
    document: window.document,
    requests,
    session: () => served,
    emit,
    confirmNext: (/** @type {boolean} */ answer) => { confirmAnswer = answer; },
    setSession: (/** @type {Session} */ next) => { served = next; },
    teardown: () => {
      clear();
      unstack(frame);
      window.close();
    },
  };
};
