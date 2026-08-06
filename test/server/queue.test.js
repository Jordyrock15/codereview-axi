import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueEntries, groupEntries, GROUPS } from '../../src/server/public/queue.js';

/**
 * @typedef {import('../../src/types.js').Comment} Comment
 */

/**
 * @param {Partial<Comment>} overrides
 * @returns {Comment}
 */
const comment = (overrides = {}) => ({
  id: 1, scope: 'line', file: 'a.js', side: 'new', startLine: 2, endLine: 2,
  quote: 'x', body: 'fix this', verdict: 'fix', status: 'open', replies: [],
  deliveredAt: null, createdAt: '', updatedAt: '', ...overrides,
});

test('an open comment appears in the queue', () => {
  const entries = queueEntries({ comments: [comment()] });
  assert.deepEqual(entries, [{ id: 1, file: 'a.js', verdict: 'fix', body: 'fix this', location: 'a.js:2' }]);
});

test('a comment re-queued by a follow-up shows the follow-up text, not the opening body', () => {
  const entries = queueEntries({
    comments: [comment({
      id: 1,
      status: 'open',
      replies: [
        { role: 'agent', body: 'fixed it', status: 'fixed', at: '', deliveredAt: null },
        { role: 'human', body: 'actually also check the negative case', status: null, at: '', deliveredAt: null },
      ],
    })],
  });
  assert.deepEqual(entries, [{
    id: 1, file: 'a.js', verdict: 'fix', body: 'actually also check the negative case', location: 'a.js:2',
  }]);
});

test('sent, answered, resolved and stale comments are excluded', () => {
  const entries = queueEntries({
    comments: [
      comment({ id: 1, status: 'sent' }),
      comment({ id: 2, status: 'answered' }),
      comment({ id: 3, status: 'resolved' }),
      comment({ id: 4, status: 'stale' }),
    ],
  });
  assert.deepEqual(entries, []);
});

test('order matches insertion order, not id or line order', () => {
  const entries = queueEntries({
    comments: [
      comment({ id: 5, status: 'open', startLine: 1, endLine: 1 }),
      comment({ id: 2, status: 'open', startLine: 9, endLine: 9 }),
    ],
  });
  assert.deepEqual(entries.map((e) => e.id), [5, 2]);
});

test('a single-line range formats as file:line', () => {
  const entries = queueEntries({ comments: [comment({ startLine: 4, endLine: 4 })] });
  assert.equal(entries[0].location, 'a.js:4');
});

test('a multi-line range formats as file:start-end', () => {
  const entries = queueEntries({ comments: [comment({ startLine: 4, endLine: 9 })] });
  assert.equal(entries[0].location, 'a.js:4-9');
});

test('a file-scope comment formats as the bare file path', () => {
  const entries = queueEntries({
    comments: [comment({
      scope: 'file', file: 'b.js', side: null, startLine: null, endLine: null, quote: '',
    })],
  });
  assert.equal(entries[0].location, 'b.js');
});

test('a session-scope comment formats as a session note, with a null file', () => {
  const entries = queueEntries({
    comments: [comment({
      scope: 'session', file: null, side: null, startLine: null, endLine: null, quote: '',
    })],
  });
  assert.equal(entries[0].location, 'session note');
  assert.equal(entries[0].file, null);
});

test('an empty queue is an empty array, not undefined or a filtered falsy value', () => {
  assert.deepEqual(queueEntries({ comments: [] }), []);
});

test('groupEntries collects a named group, not just the queue', () => {
  const session = {
    comments: [
      comment({ id: 1, status: 'open', body: 'draft' }),
      comment({ id: 2, status: 'answered', body: 'answered one' }),
      comment({ id: 3, status: 'resolved', body: 'resolved one' }),
      comment({ id: 4, status: 'sent', body: 'in flight' }),
    ],
  };

  assert.deepEqual(groupEntries(session, GROUPS.queued).map((e) => e.id), [1]);
  assert.deepEqual(groupEntries(session, GROUPS.answered).map((e) => e.id), [2]);
  assert.deepEqual(groupEntries(session, GROUPS.resolved).map((e) => e.id), [3]);
});

test('the answered and resolved groups carry the same row shape the panel renders', () => {
  const session = { comments: [comment({ id: 7, status: 'resolved', body: 'why this way?', file: 'a.js' })] };
  const [row] = groupEntries(session, GROUPS.resolved);
  assert.deepEqual(Object.keys(row).sort(), ['body', 'file', 'id', 'location', 'verdict']);
  assert.equal(row.location, 'a.js:2');
});

test('every group is disjoint, so a comment never shows in two panels at once', () => {
  const all = Object.values(GROUPS).flat();
  assert.equal(new Set(all).size, all.length);
});

test('a group of sent comments collects only what the agent holds', () => {
  const entries = groupEntries({
    comments: [
      comment({ id: 1, status: 'open', body: 'queued one' }),
      comment({ id: 2, status: 'sent', body: 'sent one' }),
      comment({ id: 3, status: 'sent', body: 'sent two' }),
      comment({ id: 4, status: 'answered', body: 'answered one' }),
    ],
  }, GROUPS.pending);
  assert.deepEqual(entries.map((e) => e.body), ['sent one', 'sent two']);
});
