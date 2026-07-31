import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionKey, mintToken, sessionUrl, openOrReuse, closeSession, reapSessions, REAP_AFTER_MS,
} from '../../src/state/sessions.js';

/** @typedef {{sessions: Record<string, any>}} State */

const snapshot = { files: [], totals: { files: 0, added: 0, removed: 0 } };
const NOW = 1_800_000_000_000;
/** @param {State} state */
const open = (state, overrides = {}) => openOrReuse(state, {
  repo: '/tmp/work', note: 'first', snapshot, port: 4390, now: NOW, ...overrides,
});

test('sessionKey is stable, hex, and path-specific', () => {
  const a = sessionKey('/Users/j/work');
  assert.equal(a, sessionKey('/Users/j/work'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, sessionKey('/Users/j/work-two'));
});

test('sessionKey treats worktrees of one repo as separate sessions', () => {
  assert.notEqual(sessionKey('/repo'), sessionKey('/repo/.worktrees/feature'));
});

test('mintToken returns 64 hex chars and never repeats', () => {
  const a = mintToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, mintToken());
});

test('sessionUrl embeds key and token on loopback', () => {
  assert.equal(sessionUrl('abc', 'tok', 4390), 'http://127.0.0.1:4390/session/abc?t=tok');
});

test('openOrReuse creates an open session with a token and no lease', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const { session, reused } = open(state);

  assert.equal(reused, false);
  assert.equal(session.status, 'open');
  assert.equal(session.closedBy, null);
  assert.equal(session.lease, null);
  assert.deepEqual(session.comments, []);
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.equal(session.repo, '/tmp/work');
  assert.equal(state.sessions[session.key], session);
});

test('openOrReuse reuses an open session, keeps its token and comments, updates the note', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const first = open(state).session;
  first.comments.push(/** @type {any} */ ({ id: 1, body: 'keep me' }));

  const { session, reused } = open(state, { note: 'second', now: NOW + 1000 });

  assert.equal(reused, true);
  assert.equal(session.token, first.token);
  assert.equal(session.comments.length, 1);
  assert.equal(session.note, 'second');
  assert.equal(session.updatedAt, new Date(NOW + 1000).toISOString());
});

test('openOrReuse never resumes a closed session and mints a fresh token', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const first = open(state).session;
  first.comments.push(/** @type {any} */ ({ id: 1, body: 'stale thread' }));
  closeSession(first, 'human', NOW + 10);

  const { session, reused } = open(state, { now: NOW + 20 });

  assert.equal(reused, false);
  assert.equal(session.status, 'open');
  assert.deepEqual(session.comments, []);
  assert.notEqual(session.token, first.token);
});

test('openOrReuse records the base', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const { session } = open(state, { base: 'main' });
  assert.equal(session.base, 'main');
});

test('a session with no base records null', () => {
  /** @type {State} */
  const state = { sessions: {} };
  assert.equal(open(state).session.base, null);
});

test('reopening with no base keeps the stored one', () => {
  /** @type {State} */
  const state = { sessions: {} };
  open(state, { base: 'main' });
  assert.equal(open(state, { now: NOW + 10 }).session.base, 'main');
});

test('reopening with a different base is refused', () => {
  /** @type {State} */
  const state = { sessions: {} };
  open(state, { base: 'main' });

  assert.throws(() => open(state, { base: 'develop', now: NOW + 10 }), (err) => {
    assert.equal(/** @type {any} */ (err).status, 409);
    assert.match(/** @type {Error} */ (err).message, /base/);
    return true;
  });
});

test('reopening a no-base session with a supplied base is refused', () => {
  /** @type {State} */
  const state = { sessions: {} };
  open(state);

  assert.throws(() => open(state, { base: 'main', now: NOW + 10 }), (err) => {
    assert.equal(/** @type {any} */ (err).status, 409);
    assert.match(/** @type {Error} */ (err).message, /base/);
    return true;
  });
});

test('reopening with the same base is fine', () => {
  /** @type {State} */
  const state = { sessions: {} };
  open(state, { base: 'main' });
  assert.equal(open(state, { base: 'main', now: NOW + 10 }).reused, true);
});

test('openOrReuse records the pr number alongside the base', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const { session } = open(state, { base: 'main', pr: 7 });
  assert.equal(session.pr, 7);
});

test('a session with no pr records null', () => {
  /** @type {State} */
  const state = { sessions: {} };
  assert.equal(open(state).session.pr, null);
});

test('reopening with no pr keeps the stored one', () => {
  /** @type {State} */
  const state = { sessions: {} };
  open(state, { base: 'main', pr: 7 });
  assert.equal(open(state, { now: NOW + 10 }).session.pr, 7);
});

test('reopening with a different pr is refused', () => {
  /** @type {State} */
  const state = { sessions: {} };
  open(state, { base: 'main', pr: 7 });

  assert.throws(() => open(state, { base: 'main', pr: 8, now: NOW + 10 }), (err) => {
    assert.equal(/** @type {any} */ (err).status, 409);
    assert.match(/** @type {Error} */ (err).message, /PR/);
    return true;
  });
});

test('reopening with the same pr is fine', () => {
  /** @type {State} */
  const state = { sessions: {} };
  open(state, { base: 'main', pr: 7 });
  assert.equal(open(state, { base: 'main', pr: 7, now: NOW + 10 }).reused, true);
});

test('a closed session with a different base is reopened as a fresh session', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const first = open(state, { base: 'main' }).session;
  closeSession(first, 'human', NOW + 10);

  const { session, reused } = open(state, { base: 'develop', now: NOW + 20 });

  assert.equal(reused, false);
  assert.equal(session.base, 'develop');
  assert.notEqual(session.token, first.token);
});

test('closeSession records who ended it', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const { session } = open(state);
  closeSession(session, 'agent', NOW + 5);

  assert.equal(session.status, 'closed');
  assert.equal(session.closedBy, 'agent');
  assert.equal(session.updatedAt, new Date(NOW + 5).toISOString());
});

test('reapSessions closes open sessions untouched for longer than the window', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const { session } = open(state);

  const reaped = reapSessions(state, NOW + REAP_AFTER_MS + 1);

  assert.deepEqual(reaped, [session.key]);
  assert.equal(session.status, 'closed');
  assert.equal(session.closedBy, 'agent');
});

test('reapSessions leaves fresh and already closed sessions alone', () => {
  /** @type {State} */
  const state = { sessions: {} };
  const { session } = open(state);
  assert.deepEqual(reapSessions(state, NOW + 1000), []);

  closeSession(session, 'human', NOW + 2000);
  assert.deepEqual(reapSessions(state, NOW + REAP_AFTER_MS + 5000), []);
});
