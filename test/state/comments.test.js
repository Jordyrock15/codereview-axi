import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addComment, patchComment, markSent, applyReply, openComments, unsentCount,
} from '../../src/state/comments.js';
import { StateError } from '../../src/state/errors.js';

const NOW = 1_800_000_000_000;

/** @returns {any} */
const session = () => ({ comments: [], updatedAt: '' });

/** @returns {any} */
const lineInput = (overrides = {}) => ({
  scope: 'line',
  file: 'src/a.js',
  side: 'new',
  startLine: 42,
  endLine: 42,
  quote: 'return shares.map(Math.round);',
  body: 'loses pennies',
  verdict: 'fix',
  ...overrides,
});

test('addComment assigns ids from 1 and starts open', () => {
  const s = session();
  const first = addComment(s, lineInput(), NOW);
  const second = addComment(s, lineInput({ startLine: 50, endLine: 50 }), NOW);

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(first.status, 'open');
  assert.equal(first.agentReply, null);
  assert.equal(first.createdAt, new Date(NOW).toISOString());
});

test('addComment defaults the verdict to fix', () => {
  const s = session();
  const comment = addComment(s, lineInput({ verdict: undefined }), NOW);
  assert.equal(comment.verdict, 'fix');
});

test('addComment nulls line fields for session scope', () => {
  const s = session();
  const comment = addComment(s, { scope: 'session', body: 'overall this is fine' }, NOW);
  assert.equal(comment.file, null);
  assert.equal(comment.side, null);
  assert.equal(comment.startLine, null);
  assert.equal(comment.quote, '');
});

test('addComment rejects an empty body', () => {
  const s = session();
  assert.throws(() => addComment(s, lineInput({ body: '   ' }), NOW), (err) => {
    assert.ok(err instanceof StateError);
    assert.equal(err.status, 400);
    return true;
  });
});

test('addComment rejects an unknown verdict', () => {
  const s = session();
  assert.throws(() => addComment(s, lineInput({ verdict: 'maybe' }), NOW), /verdict/);
});

test('patchComment edits body and verdict', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  const patched = patchComment(s, 1, { body: 'clearer wording', verdict: 'explain' }, NOW + 5);

  assert.equal(patched.body, 'clearer wording');
  assert.equal(patched.verdict, 'explain');
  assert.equal(patched.updatedAt, new Date(NOW + 5).toISOString());
});

test('patchComment resolves and reopens an answered comment', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);

  assert.equal(patchComment(s, 1, { status: 'resolved' }, NOW).status, 'resolved');
  assert.equal(patchComment(s, 1, { status: 'reopened' }, NOW).status, 'reopened');
});

test('patchComment refuses to resolve a comment the agent has not answered', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  assert.throws(() => patchComment(s, 1, { status: 'resolved' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });
});

test('patchComment names staleness rather than the agent when refusing a stale comment', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  s.comments[0].status = 'stale';
  assert.throws(() => patchComment(s, 1, { status: 'resolved' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    assert.equal(err.message, 'comment 1 is stale, its code no longer exists');
    return true;
  });
});

test('patchComment 404s on an unknown id', () => {
  assert.throws(() => patchComment(session(), 99, { body: 'x' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 404);
    return true;
  });
});

test('markSent moves open and reopened comments to sent and returns them', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  addComment(s, lineInput({ startLine: 50, endLine: 50 }), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);
  patchComment(s, 1, { status: 'reopened' }, NOW);

  const sent = markSent(s, NOW + 10);

  assert.deepEqual(sent.map((c) => c.id), [1]);
  assert.equal(s.comments[0].status, 'sent');
});

test('markSent returns an empty array when nothing is open', () => {
  assert.deepEqual(markSent(session(), NOW), []);
});

test('applyReply moves a sent comment to answered and stores the reply', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  const replied = applyReply(s, 1, { status: 'fixed', body: 'remainder distributed' }, NOW + 20);

  assert.equal(replied.status, 'answered');
  const { agentReply } = replied;
  assert.ok(agentReply);
  assert.equal(agentReply.status, 'fixed');
  assert.equal(agentReply.body, 'remainder distributed');
  assert.equal(agentReply.at, new Date(NOW + 20).toISOString());
});

test('applyReply 409s when the comment was never sent', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  assert.throws(() => applyReply(s, 1, { status: 'fixed', body: 'x' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });
});

test('applyReply 409s when the comment is already resolved', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'x' }, NOW);
  patchComment(s, 1, { status: 'resolved' }, NOW);

  assert.throws(() => applyReply(s, 1, { status: 'fixed', body: 'again' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });
});

test('applyReply rejects an unknown reply status', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  assert.throws(() => applyReply(s, 1, { status: 'done', body: 'x' }, NOW), /status/);
});

test('openComments and unsentCount report what Send would take', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  addComment(s, lineInput({ startLine: 50, endLine: 50 }), NOW);
  assert.equal(unsentCount(s), 2);

  markSent(s, NOW);
  assert.equal(unsentCount(s), 0);
  assert.deepEqual(openComments(s), []);
});
