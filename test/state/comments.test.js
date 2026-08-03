import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addComment, patchComment, markSent, applyReply, addFollowup, removeQueued,
  hasUndeliveredHuman, markDelivered, openComments, unsentCount,
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
  assert.deepEqual(first.replies, []);
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

test('patchComment resolves an answered comment', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);

  assert.equal(patchComment(s, 1, { status: 'resolved' }, NOW).status, 'resolved');
});

test('patchComment refuses to resolve a comment the agent has not answered', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  assert.throws(() => patchComment(s, 1, { status: 'resolved' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });
});

test('patchComment refuses reopened, no status other than resolved can be set', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);

  assert.throws(() => patchComment(s, 1, { status: 'reopened' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 400);
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

test('patchComment still refuses to resolve a stale comment with 409', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  s.comments[0].status = 'stale';

  assert.throws(() => patchComment(s, 1, { status: 'resolved' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });
});

test('patchComment 404s on an unknown id', () => {
  assert.throws(() => patchComment(session(), 99, { body: 'x' }, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 404);
    return true;
  });
});

test('editing a delivered comment makes it deliverable again', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  s.comments[0].deliveredAt = new Date(NOW).toISOString();

  patchComment(s, 1, { body: 'clearer wording' }, NOW + 5);

  assert.equal(s.comments[0].deliveredAt, null, 'an edit is new information and must reach the agent');
});

test('markSent moves open comments to sent and returns them', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  addComment(s, lineInput({ startLine: 50, endLine: 50 }), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);
  addFollowup(s, 1, 'actually check the negative case too', NOW);

  const sent = markSent(s, NOW + 10);

  assert.deepEqual(sent.map((c) => c.id), [1]);
  assert.equal(s.comments[0].status, 'sent');
});

test('markSent leaves an already-delivered opening message alone: only the new message needs delivering', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  s.comments[0].deliveredAt = new Date(NOW).toISOString();
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);
  addFollowup(s, 1, 'one more thing', NOW);

  markSent(s, NOW + 10);

  assert.equal(s.comments[0].status, 'sent');
  assert.notEqual(s.comments[0].deliveredAt, null, 'the opening message was already delivered and stays that way');
  const [followup] = s.comments[0].replies.filter((/** @type {any} */ m) => m.role === 'human');
  assert.equal(followup.deliveredAt, null, 'the follow-up itself is what still needs delivering');
});

test('markSent returns an empty array when nothing is open', () => {
  assert.deepEqual(markSent(session(), NOW), []);
});

test('applyReply moves a sent comment to answered and appends a reply message', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  const replied = applyReply(s, 1, { status: 'fixed', body: 'remainder distributed' }, NOW + 20);

  assert.equal(replied.status, 'answered');
  assert.equal(replied.replies.length, 1);
  const [message] = replied.replies;
  assert.equal(message.role, 'agent');
  assert.equal(message.status, 'fixed');
  assert.equal(message.body, 'remainder distributed');
  assert.equal(message.at, new Date(NOW + 20).toISOString());
});

test('applyReply appends rather than overwrites: two replies across a follow-up round produce two messages', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'first fix' }, NOW);
  addFollowup(s, 1, 'also check the negative case', NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'explained', body: 'negative case cannot occur here' }, NOW);

  const roles = s.comments[0].replies.map((/** @type {any} */ m) => `${m.role}:${m.body}`);
  assert.deepEqual(roles, [
    'agent:first fix',
    'human:also check the negative case',
    'agent:negative case cannot occur here',
  ]);
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

test('addFollowup requeues an answered comment with new text, leaving it undelivered', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);

  const followed = addFollowup(s, 1, 'actually, one more thing', NOW + 5);

  assert.equal(followed.status, 'open');
  assert.equal(followed.replies.length, 2);
  const [, message] = followed.replies;
  assert.equal(message.role, 'human');
  assert.equal(message.body, 'actually, one more thing');
  assert.equal(message.deliveredAt, null);
});

test('addFollowup rejects an empty body', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);

  assert.throws(() => addFollowup(s, 1, '   ', NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test('addFollowup refuses a comment that was never sent, replying twice, or resolved', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  assert.throws(() => addFollowup(s, 1, 'text', NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });

  markSent(s, NOW);
  assert.throws(() => addFollowup(s, 1, 'text', NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });

  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);
  patchComment(s, 1, { status: 'resolved' }, NOW);
  assert.throws(() => addFollowup(s, 1, 'text', NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });
});

test('addFollowup 404s on an unknown id', () => {
  assert.throws(() => addFollowup(session(), 99, 'text', NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 404);
    return true;
  });
});

test('removeQueued deletes a fresh comment outright', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  const result = removeQueued(s, 1, NOW);

  assert.deepEqual(result, { removed: true });
  assert.equal(s.comments.length, 0);
});

test('removeQueued on a re-queued follow-up cancels only the draft, keeping the answered exchange', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);
  addFollowup(s, 1, 'one more thing', NOW);

  const result = removeQueued(s, 1, NOW + 5);

  assert.equal(result.removed, false);
  assert.equal(s.comments[0].status, 'answered');
  assert.equal(s.comments[0].replies.length, 1, 'the prior agent reply must survive cancelling the draft follow-up');
  assert.equal(s.comments[0].replies[0].role, 'agent');
});

test('removeQueued refuses a comment that is not queued', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  assert.throws(() => removeQueued(s, 1, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 409);
    return true;
  });
});

test('removeQueued 404s an unknown id', () => {
  assert.throws(() => removeQueued(session(), 99, NOW), (/** @type {any} */ err) => {
    assert.equal(err.status, 404);
    return true;
  });
});

test('hasUndeliveredHuman is true for a freshly sent comment, and for a sent follow-up', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  assert.equal(hasUndeliveredHuman(s.comments[0]), true);

  markDelivered(s.comments[0], new Date(NOW).toISOString());
  assert.equal(hasUndeliveredHuman(s.comments[0]), false);

  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);
  addFollowup(s, 1, 'one more thing', NOW);
  markSent(s, NOW);
  assert.equal(hasUndeliveredHuman(s.comments[0]), true, 'the follow-up itself is undelivered even though the opening message already was');
});

test('hasUndeliveredHuman is false while a comment is not sent, regardless of delivery stamps', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  assert.equal(hasUndeliveredHuman(s.comments[0]), false);
});

test('markDelivered stamps the opening message once and every undelivered human reply, never an agent reply', () => {
  const s = session();
  addComment(s, lineInput(), NOW);
  markSent(s, NOW);
  const firstDelivery = new Date(NOW).toISOString();
  markDelivered(s.comments[0], firstDelivery);

  applyReply(s, 1, { status: 'fixed', body: 'done' }, NOW);
  addFollowup(s, 1, 'one more thing', NOW);
  markSent(s, NOW);

  const at = new Date(NOW + 10).toISOString();
  markDelivered(s.comments[0], at);

  assert.equal(s.comments[0].deliveredAt, firstDelivery, 'already delivered, must not be re-stamped');
  const [agentMessage, humanMessage] = s.comments[0].replies;
  assert.equal(agentMessage.deliveredAt, null, 'an agent message is never delivered by this mechanism');
  assert.equal(humanMessage.deliveredAt, at);
});
