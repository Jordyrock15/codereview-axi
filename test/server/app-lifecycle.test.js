import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApp, sessionFixture, commentFixture, settle } from '../helpers/dom.js';
import { OVERLAY_REFRESHED_MIN_VISIBLE_MS } from '../../src/server/public/overlay.js';

/**
 * @param {Document} document
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
const button = (document, id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));

/**
 * Polls `predicate` until it is true or `deadlineMs` runs out, then reports
 * the last observed value, so a slow machine gets more time and a fast one
 * does not waste any.
 * @param {() => boolean} predicate
 * @param {number} deadlineMs
 * @returns {Promise<boolean>}
 */
const waitFor = async (predicate, deadlineMs) => {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
};

/**
 * The terminal state Done and a `closed` stream event must both reach,
 * including that the stream is shut so no reload can follow.
 * @param {import('../helpers/dom.js').Mounted} app
 * @returns {Promise<void>}
 */
const assertTerminal = async (app) => {
  assert.equal(button(app.document, 'send').disabled, true);
  assert.equal(button(app.document, 'done').disabled, true);
  assert.equal(app.document.getElementById('ident')?.textContent, 'Session closed');
  assert.equal(app.document.getElementById('say')?.textContent, 'You can close this tab.');
  assert.equal(app.document.getElementById('stream')?.textContent, 'disconnected');
  assert.equal(app.document.getElementById('stream')?.getAttribute('data-state'), 'down');

  const requestCount = () => app.requests.filter((r) => r.method === 'GET' && r.path === '').length;
  const before = requestCount();
  await app.emit('comment');
  assert.equal(requestCount(), before, 'the stream must be closed, so a later event fetches nothing');
};

test('an empty queue leaves Send disabled and unnumbered', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    assert.equal(button(app.document, 'send').disabled, false);

    app.setSession(sessionFixture({ comments: [] }));
    await app.emit('comment');

    assert.equal(button(app.document, 'send').disabled, true);
    assert.equal(button(app.document, 'send').textContent, 'Send');
  } finally {
    app.teardown();
  }
});

test('a queued comment enables Send and counts it', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    assert.equal(button(app.document, 'send').disabled, false);
    assert.equal(button(app.document, 'send').textContent, 'Send 1');
    assert.equal(app.document.getElementById('queue-open')?.textContent, 'Queued 1');
  } finally {
    app.teardown();
  }
});

test('sending moves a comment from queued to pending', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    assert.equal(app.document.getElementById('queue-open')?.textContent, 'Queued 1');
    assert.equal(app.document.getElementById('pending-open')?.textContent, 'Pending 0');

    button(app.document, 'send').click();
    await settle();

    assert.equal(app.document.getElementById('queue-open')?.textContent, 'Queued 0');
    assert.equal(app.document.getElementById('pending-open')?.textContent, 'Pending 1');
  } finally {
    app.teardown();
  }
});

test('a round still owed blocks Send and says why', async () => {
  const app = await mountApp({
    session: sessionFixture({
      comments: [commentFixture({ id: 1, status: 'open' }), commentFixture({ id: 2, status: 'sent' })],
    }),
  });
  try {
    const send = button(app.document, 'send');
    assert.equal(send.disabled, true);
    assert.equal(send.title, 'The agent still owes a reply. Your drafts stay queued until it has answered.');
    assert.equal(button(app.document, 'queue-send').disabled, true);
  } finally {
    app.teardown();
  }
});

test('a stale comment is reported next to the counters', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'stale' })] }) });
  try {
    assert.equal(app.document.getElementById('counts-unsent')?.textContent, '1 stale');
    assert.equal(app.document.getElementById('counts-rest')?.textContent, '');
  } finally {
    app.teardown();
  }
});

test('Send posts the round and reloads', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    button(app.document, 'send').click();
    await settle();

    assert.ok(app.requests.some((r) => r.method === 'POST' && r.path === '/send'));
    const send = button(app.document, 'send');
    assert.equal(send.disabled, true, 'the reload must show the round the send just started as still owed');
    assert.equal(send.title, 'The agent still owes a reply. Your drafts stay queued until it has answered.');
  } finally {
    app.teardown();
  }
});

test('the view toggle patches the session', async () => {
  const app = await mountApp();
  try {
    button(app.document, 'view').click();
    await settle();

    const patched = app.requests.find((r) => r.method === 'PATCH' && r.path === '/view');
    assert.deepEqual(patched?.body, { view: 'split' });
    assert.equal(app.document.getElementById('view')?.textContent, 'unified');
  } finally {
    app.teardown();
  }
});

test('Done confirms, closes the session and locks the tab', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    assert.equal(button(app.document, 'send').disabled, false, 'Send must start enabled, so Done proves it disables Send');

    app.confirmNext(true);
    button(app.document, 'done').click();
    await settle();

    const closed = app.requests.find((r) => r.method === 'POST' && r.path === '/close');
    assert.deepEqual(closed?.body, { closedBy: 'human' });
    await assertTerminal(app);
  } finally {
    app.teardown();
  }
});

test('a cancelled confirm changes nothing', async () => {
  const app = await mountApp();
  try {
    app.confirmNext(false);
    button(app.document, 'done').click();
    await settle();

    assert.equal(app.requests.some((r) => r.path === '/close'), false);
    assert.equal(button(app.document, 'done').disabled, false);
  } finally {
    app.teardown();
  }
});

test('a refused close never claims the session ended', async () => {
  const app = await mountApp({ routes: { 'POST /close': () => ({ status: 500, json: null }) } });
  try {
    app.confirmNext(true);
    button(app.document, 'done').click();
    await settle();

    assert.ok(app.requests.some((r) => r.method === 'POST' && r.path === '/close'));
    assert.notEqual(app.document.getElementById('ident')?.textContent, 'Session closed');
    // The reload succeeded, so the note is the fixture's real value, not the shell's empty default.
    assert.equal(app.document.getElementById('say')?.textContent, 'two comments answered');
    assert.equal(button(app.document, 'done').disabled, false);
    // No stream event fired, so the badge stays at its own untouched shell default.
    assert.equal(app.document.getElementById('stream')?.textContent, 'connecting');
    assert.equal(app.document.getElementById('stream')?.getAttribute('data-state'), null);
  } finally {
    app.teardown();
  }
});

test('the stream badge follows the connection', async () => {
  const app = await mountApp();
  try {
    await app.emit('open');
    assert.equal(app.document.getElementById('stream')?.textContent, 'connected');
    assert.equal(app.document.getElementById('stream')?.getAttribute('data-state'), 'up');

    await app.emit('error');
    assert.equal(app.document.getElementById('stream')?.textContent, 'disconnected');
    assert.equal(app.document.getElementById('stream')?.getAttribute('data-state'), 'down');
  } finally {
    app.teardown();
  }
});

test('a comment event reloads the session', async () => {
  const app = await mountApp();
  try {
    const before = app.requests.filter((r) => r.method === 'GET' && r.path === '').length;
    await app.emit('comment');
    const after = app.requests.filter((r) => r.method === 'GET' && r.path === '').length;
    assert.equal(after, before + 1);
  } finally {
    app.teardown();
  }
});

test('a refreshed event reveals the overlay while it reloads', async () => {
  const app = await mountApp();
  try {
    await app.emit('refreshed');
    const overlay = /** @type {HTMLElement} */ (app.document.getElementById('diff-overlay'));
    assert.equal(overlay.classList.contains('visible'), true);
    assert.equal(app.document.getElementById('diff-overlay-label')?.textContent, 'Refreshing');
  } finally {
    app.teardown();
  }
});

test('the overlay clears itself once its minimum time is up', async () => {
  const app = await mountApp();
  try {
    await app.emit('refreshed');
    const overlay = /** @type {HTMLElement} */ (app.document.getElementById('diff-overlay'));
    assert.equal(overlay.classList.contains('visible'), true, 'the overlay must actually show before this test can prove it clears');

    await new Promise((resolve) => setTimeout(resolve, OVERLAY_REFRESHED_MIN_VISIBLE_MS - 100));
    assert.equal(overlay.classList.contains('visible'), true, 'the overlay must stay up for its full minimum time, not clear early');

    const cleared = await waitFor(() => !overlay.classList.contains('visible'), OVERLAY_REFRESHED_MIN_VISIBLE_MS * 2);
    assert.equal(cleared, true, 'the overlay never cleared within the deadline');
  } finally {
    app.teardown();
  }
});

test('a closed event reaches the same terminal state as Done', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    assert.equal(button(app.document, 'send').disabled, false, 'Send must start enabled, so the event proves it disables Send');

    await app.emit('closed');
    await assertTerminal(app);
  } finally {
    app.teardown();
  }
});

test('expand fetches the lines above a hunk and replaces its button', async () => {
  const app = await mountApp();
  try {
    /** @type {HTMLElement} */ (app.document.querySelector('#diff .expand')).click();
    await settle();

    const asked = app.requests.find((r) => r.method === 'GET' && r.path.startsWith('/context'));
    assert.equal(asked?.path, '/context?file=src%2Fa.js&from=2&to=9');
    assert.equal(app.document.querySelectorAll('#diff .expand').length, 0);
    // The fake /context route always returns two lines, so this count reflects the fake, not the server.
    assert.equal(app.document.querySelectorAll('#diff .row').length, 5);

    const first = app.document.querySelector('#diff .row[data-new-line="2"]');
    const second = app.document.querySelector('#diff .row[data-new-line="3"]');
    assert.equal(first?.querySelector('.t')?.textContent, 'const above = 1;');
    assert.equal(second?.querySelector('.t')?.textContent, 'const above2 = 2;');
    assert.equal(first?.getAttribute('data-old-line'), '');
    assert.equal(second?.getAttribute('data-old-line'), '');
  } finally {
    app.teardown();
  }
});

test('a refused context fetch leaves the expand button in place', async () => {
  const app = await mountApp({ routes: { 'GET /context': () => ({ status: 500, json: null }) } });
  try {
    const expand = /** @type {HTMLElement} */ (app.document.querySelector('#diff .expand'));
    expand.click();
    await settle();

    assert.equal(app.document.querySelectorAll('#diff .expand').length, 1);
    assert.ok(app.document.contains(expand), 'the same expand button must still be on screen, not rebuilt');
  } finally {
    app.teardown();
  }
});
