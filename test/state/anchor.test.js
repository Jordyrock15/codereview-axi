import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reanchor } from '../../src/state/anchor.js';

const NOW = 1_800_000_000_000;

/**
 * Builds a snapshot whose new side is exactly the given lines.
 * @param {string} path
 * @param {string[]} lines
 * @returns {any}
 */
const snapshotOf = (path, lines) => ({
  files: [{
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    added: lines.length,
    removed: 0,
    tags: [],
    hunks: [{
      oldStart: 1,
      oldLines: lines.length,
      newStart: 1,
      newLines: lines.length,
      header: '',
      lines: lines.map((text, i) => ({ kind: 'context', text, oldLine: i + 1, newLine: i + 1 })),
    }],
  }],
  totals: { files: 1, added: lines.length, removed: 0 },
});

/** @returns {any} */
const comment = (overrides = {}) => ({
  id: 1,
  scope: 'line',
  file: 'a.js',
  side: 'new',
  startLine: 3,
  endLine: 3,
  quote: 'target line',
  body: 'fix this',
  verdict: 'fix',
  status: 'open',
  replies: [],
  createdAt: '', updatedAt: '',
  ...overrides,
});

test('relocates an open comment silently when its quote moved', () => {
  /** @type {any} */
  const session = { comments: [comment()], updatedAt: '' };
  const snapshot = snapshotOf('a.js', ['x', 'y', 'z', 'w', 'target line']);

  const result = reanchor(session, snapshot);

  assert.deepEqual(result, { relocated: [1], stale: [] });
  assert.equal(session.comments[0].startLine, 5);
  assert.equal(session.comments[0].endLine, 5);
  assert.equal(session.comments[0].status, 'open');
});

test('leaves an open comment untouched when the quote is still in place', () => {
  /** @type {any} */
  const session = { comments: [comment()], updatedAt: '' };
  const snapshot = snapshotOf('a.js', ['x', 'y', 'target line']);

  assert.deepEqual(reanchor(session, snapshot), { relocated: [], stale: [] });
  assert.equal(session.comments[0].startLine, 3);
});

test('marks an open comment stale when its quote is gone', () => {
  /** @type {any} */
  const session = { comments: [comment()], updatedAt: '' };
  const snapshot = snapshotOf('a.js', ['x', 'y', 'something else']);

  assert.deepEqual(reanchor(session, snapshot), { relocated: [], stale: [1] });
  assert.equal(session.comments[0].status, 'stale');
  assert.equal(session.comments[0].quote, 'target line', 'the quote survives so the thread stays readable');
});

test('prefers the nearest match when the quote appears more than once', () => {
  /** @type {any} */
  const session = { comments: [comment({ startLine: 8 })], updatedAt: '' };
  const snapshot = snapshotOf('a.js', [
    'target line', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'target line',
  ]);

  reanchor(session, snapshot);
  assert.equal(session.comments[0].startLine, 10);
});

test('relocates a multi-line range and keeps its length', () => {
  /** @type {any} */
  const session = { comments: [comment({ startLine: 2, endLine: 3, quote: 'one\ntwo' })], updatedAt: '' };
  const snapshot = snapshotOf('a.js', ['x', 'y', 'z', 'one', 'two']);

  reanchor(session, snapshot);
  assert.equal(session.comments[0].startLine, 4);
  assert.equal(session.comments[0].endLine, 5);
});

test('never re-anchors an answered comment, even when its quote is gone', () => {
  /** @type {any} */
  const session = {
    comments: [comment({ status: 'answered', replies: [{ role: 'agent', status: 'fixed', body: 'done', at: '', deliveredAt: null }] })],
    updatedAt: '',
  };
  const snapshot = snapshotOf('a.js', ['x', 'y', 'rewritten entirely']);

  assert.deepEqual(reanchor(session, snapshot), { relocated: [], stale: [] });
  assert.equal(session.comments[0].status, 'answered');
  assert.equal(session.comments[0].startLine, 3);
});

test('never re-anchors a resolved comment', () => {
  /** @type {any} */
  const session = { comments: [comment({ status: 'resolved' })], updatedAt: '' };
  // @ts-expect-error extra argument is harmless; reanchor takes no clock
  assert.deepEqual(reanchor(session, snapshotOf('a.js', ['gone']), NOW), { relocated: [], stale: [] });
  assert.equal(session.comments[0].status, 'resolved');
});

test('re-anchors a comment re-queued by a follow-up, same as any other open comment', () => {
  /** @type {any} */
  const session = {
    comments: [comment({
      status: 'open',
      replies: [
        { role: 'agent', status: 'fixed', body: 'done', at: '', deliveredAt: null },
        { role: 'human', status: null, body: 'one more thing', at: '', deliveredAt: null },
      ],
    })],
    updatedAt: '',
  };
  reanchor(session, snapshotOf('a.js', ['x', 'y', 'z', 'target line']));
  assert.equal(session.comments[0].startLine, 4);
  assert.equal(session.comments[0].status, 'open');
});

test('marks an open comment stale when its file left the diff entirely', () => {
  /** @type {any} */
  const session = { comments: [comment()], updatedAt: '' };
  assert.deepEqual(reanchor(session, snapshotOf('other.js', ['x'])), { relocated: [], stale: [1] });
});

test('leaves file and session scoped comments alone', () => {
  /** @type {any} */
  const session = {
    comments: [
      comment({ id: 1, scope: 'file', startLine: null, endLine: null, quote: '' }),
      comment({ id: 2, scope: 'session', file: null, startLine: null, endLine: null, quote: '' }),
    ],
    updatedAt: '',
  };
  assert.deepEqual(reanchor(session, snapshotOf('a.js', ['x'])), { relocated: [], stale: [] });
});

test('a stale comment stays stale rather than flapping back', () => {
  /** @type {any} */
  const session = { comments: [comment({ status: 'stale' })], updatedAt: '' };
  reanchor(session, snapshotOf('a.js', ['target line']));
  assert.equal(session.comments[0].status, 'stale');
});
