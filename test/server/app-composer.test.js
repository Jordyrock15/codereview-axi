import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountApp, sessionFixture, commentFixture, plainSession, splitSession, twoHunkSession, settle,
} from '../helpers/dom.js';

/**
 * @param {import('../helpers/dom.js').Mounted} app
 * @param {number} line
 * @param {{shiftKey?: boolean, side?: 'old'|'new'}} [options]
 * @returns {void}
 */
const clickGutter = (app, line, options = {}) => {
  const side = options.side === 'old' ? 'old' : 'new';
  const row = /** @type {HTMLElement} */ (app.document.querySelector(`#diff .row[data-${side}-line="${line}"]`));
  const gutter = /** @type {HTMLElement} */ (row.querySelectorAll('.n')[side === 'old' ? 0 : 1]);
  gutter.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, shiftKey: options.shiftKey ?? false }));
};

/**
 * @param {Element} node
 * @returns {Element|null}
 */
const nearestPrecedingRow = (node) => {
  let sibling = node.previousElementSibling;
  while (sibling && !sibling.classList.contains('row')) sibling = sibling.previousElementSibling;
  return sibling;
};

test('a gutter click opens the composer with the line in its heading', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const composer = app.document.querySelector('#diff .thread.composer');
    assert.ok(composer);
    assert.equal(composer?.querySelector('.annotate-label')?.textContent, 'Annotate');
    assert.equal(composer?.querySelector('.base')?.textContent, 'a.js:11');
    assert.equal(composer?.querySelector('.dir')?.textContent, 'src/');
    assert.equal(/** @type {HTMLElement} */ (composer?.querySelector('.who')).title, 'src/a.js:11');
    assert.equal(composer?.querySelector('.warn')?.textContent, '');
  } finally {
    app.teardown();
  }
});

test('the picked row is highlighted', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const picked = app.document.querySelectorAll('#diff .row.picked');
    assert.equal(picked.length, 1);
    assert.equal(picked[0].getAttribute('data-new-line'), '11');
  } finally {
    app.teardown();
  }
});

test('a split pick marks the cell on its own side and opens the composer', async () => {
  const app = await mountApp({ session: splitSession() });
  try {
    clickGutter(app, 11);

    const picked = app.document.querySelectorAll('#diff .row.split .t.picked');
    assert.equal(picked.length, 1);
    assert.equal(picked[0].getAttribute('data-side'), 'new');
    assert.equal(picked[0].parentElement?.getAttribute('data-new-line'), '11');
    assert.equal(
      app.document.querySelectorAll('#diff .row.picked').length,
      0,
      'a split pick must not mark the whole row, the other column holds unrelated code',
    );

    const composer = app.document.querySelector('#diff .thread.composer');
    assert.equal(composer?.querySelector('.base')?.textContent, 'a.js:11');
  } finally {
    app.teardown();
  }
});

test('a split gutter with no line on its side does nothing', async () => {
  const app = await mountApp({ session: splitSession() });
  try {
    const row = /** @type {HTMLElement} */ (app.document.querySelector('#diff .row[data-new-line="12"]'));
    assert.equal(row.getAttribute('data-old-line'), '', 'this row must have a blank old gutter to test');

    /** @type {HTMLElement} */ (row.querySelectorAll('.n')[0])
      .dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));

    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
    assert.equal(app.document.querySelectorAll('#diff .picked').length, 0);
  } finally {
    app.teardown();
  }
});

test('a shift-extend keeps the typed text and widens the heading', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const text = /** @type {HTMLTextAreaElement} */ (app.document.querySelector('#diff .thread.composer textarea'));
    text.value = 'half a thought';
    text.dispatchEvent(new app.window.Event('input'));

    clickGutter(app, 13, { shiftKey: true });

    const composer = app.document.querySelector('#diff .thread.composer');
    assert.equal(composer?.querySelector('textarea'), text, 'the shift-extend must reuse the composer, not rebuild it');
    assert.equal(text.value, 'half a thought');
    assert.equal(composer?.querySelector('.base')?.textContent, 'a.js:11-13');
    assert.equal(app.document.querySelectorAll('#diff .row.picked').length, 3);
  } finally {
    app.teardown();
  }
});

test('a shift-click on the other side restarts and says why', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    clickGutter(app, 12, { shiftKey: true, side: 'old' });
    assert.equal(
      app.document.querySelector('#diff .thread.composer .warn')?.textContent,
      'Selection crosses a hunk boundary. Pick a single unbroken range and try again.',
    );
  } finally {
    app.teardown();
  }
});

test('a shift-click into a second hunk restarts and says why', async () => {
  const app = await mountApp({ session: twoHunkSession() });
  try {
    clickGutter(app, 11);
    clickGutter(app, 30, { shiftKey: true });

    assert.equal(
      app.document.querySelector('#diff .thread.composer .warn')?.textContent,
      'Selection crosses a hunk boundary. Pick a single unbroken range and try again.',
    );
    const picked = app.document.querySelectorAll('#diff .row.picked');
    assert.equal(picked.length, 1, 'the rejected shift-click starts a fresh one-line selection');
    assert.equal(picked[0].getAttribute('data-new-line'), '30');
    assert.equal(app.document.querySelector('#diff .thread.composer .base')?.textContent, 'a.js:30');
  } finally {
    app.teardown();
  }
});

test('a successful shift-extend clears an earlier restart note', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    clickGutter(app, 12, { shiftKey: true, side: 'old' });
    const text = /** @type {HTMLTextAreaElement} */ (app.document.querySelector('#diff .thread.composer textarea'));
    clickGutter(app, 13, { shiftKey: true, side: 'old' });
    const composer = app.document.querySelector('#diff .thread.composer');
    assert.equal(composer?.querySelector('textarea'), text, 'the shift-extend must reuse the composer, not rebuild it');
    assert.equal(composer?.querySelector('.warn')?.textContent, '');
  } finally {
    app.teardown();
  }
});

test('the verdict buttons track which one is pressed', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const buttons = [...app.document.querySelectorAll('#diff .thread.composer .verdicts button')];
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);

    /** @type {HTMLElement} */ (buttons[1]).click();
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  } finally {
    app.teardown();
  }
});

test('Queue posts the range, the quote and the verdict', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    clickGutter(app, 12, { shiftKey: true });
    const composer = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread.composer'));
    const text = /** @type {HTMLTextAreaElement} */ (composer.querySelector('textarea'));
    text.value = 'name these';
    text.dispatchEvent(new app.window.Event('input'));
    /** @type {HTMLElement} */ (composer.querySelectorAll('.verdicts button')[1]).click();

    /** @type {HTMLElement} */ (composer.querySelector('.actions .primary')).click();
    await settle();

    const posted = app.requests.find((r) => r.method === 'POST' && r.path === '/comments');
    assert.deepEqual(posted?.body, {
      scope: 'line', file: 'src/a.js', side: 'new', startLine: 11, endLine: 12,
      quote: 'line 11;\nline 12;', body: 'name these', verdict: 'explain',
    });
    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
  } finally {
    app.teardown();
  }
});

test('empty text is refused without a request', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread.composer .actions .primary')).click();
    await settle();
    assert.equal(app.requests.some((r) => r.path === '/comments'), false);
    assert.ok(app.document.querySelector('#diff .thread.composer'));
  } finally {
    app.teardown();
  }
});

test("a server error reaches the composer's warning line", async () => {
  const app = await mountApp({
    session: plainSession(),
    routes: { 'POST /comments': () => ({ status: 409, json: { error: 'A round is already in flight.' } }) },
  });
  try {
    clickGutter(app, 11);
    const composer = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread.composer'));
    const text = /** @type {HTMLTextAreaElement} */ (composer.querySelector('textarea'));
    text.value = 'name this';
    text.dispatchEvent(new app.window.Event('input'));
    /** @type {HTMLElement} */ (composer.querySelector('.actions .primary')).click();
    await settle();

    assert.equal(composer.querySelector('.warn')?.textContent, 'A round is already in flight.');
    assert.equal(/** @type {HTMLButtonElement} */ (composer.querySelector('.actions .primary')).disabled, false);
  } finally {
    app.teardown();
  }
});

test('Cancel closes the composer and drops the highlight', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const text = /** @type {HTMLTextAreaElement} */ (app.document.querySelector('#diff .thread.composer textarea'));
    text.value = 'half a thought';
    text.dispatchEvent(new app.window.Event('input'));

    const buttons = [...app.document.querySelectorAll('#diff .thread.composer .actions button')];
    /** @type {HTMLElement} */ (buttons[0]).click();
    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
    assert.equal(app.document.querySelectorAll('#diff .row.picked').length, 0);

    clickGutter(app, 11);
    const reopened = /** @type {HTMLTextAreaElement} */ (app.document.querySelector('#diff .thread.composer textarea'));
    assert.equal(reopened.value, '', 'Cancel must drop the draft, not just close the composer');
  } finally {
    app.teardown();
  }
});

test('Escape closes the composer', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
    assert.equal(app.document.querySelectorAll('#diff .row.picked').length, 0);
  } finally {
    app.teardown();
  }
});

test('a draft survives a re-render, and the composer comes back', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    clickGutter(app, 13, { shiftKey: true });
    const text = /** @type {HTMLTextAreaElement} */ (app.document.querySelector('#diff .thread.composer textarea'));
    text.value = 'half a thought';
    text.dispatchEvent(new app.window.Event('input'));

    const rowBefore = app.document.querySelector('#diff .row[data-new-line="13"]');

    await app.emit('comment');

    const rowAfter = app.document.querySelector('#diff .row[data-new-line="13"]');
    assert.notEqual(rowAfter, rowBefore, 'the diff pane itself must be rebuilt, not just the composer closed and reopened');

    const composer = app.document.querySelector('#diff .thread.composer');
    assert.ok(composer, 'the composer is rebuilt after the render wiped it');
    const reopened = /** @type {HTMLTextAreaElement} */ (composer?.querySelector('textarea'));
    assert.notEqual(reopened, text, 'a rebuilt composer must hold a freshly-created textarea, proving the render actually ran');
    assert.equal(reopened.value, 'half a thought');
    assert.equal(
      nearestPrecedingRow(/** @type {Element} */ (composer))?.getAttribute('data-new-line'),
      '13',
      "the composer must reopen after the range's end row, not its start",
    );
  } finally {
    app.teardown();
  }
});

test('Reply posts a follow-up rather than resending the body', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'answered' })] }),
  });
  try {
    const thread = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread[data-comment-id="1"]'));
    /** @type {HTMLElement} */ (thread.querySelectorAll('.actions button')[0]).click();

    const followup = /** @type {HTMLElement} */ (thread.querySelector('.thread.composer.followup'));
    const text = /** @type {HTMLTextAreaElement} */ (followup.querySelector('textarea'));
    text.value = 'still wrong';
    /** @type {HTMLElement} */ (followup.querySelector('.actions .primary')).click();
    await settle();

    const posted = app.requests.find((r) => r.method === 'POST' && r.path === '/comments/1/followup');
    assert.deepEqual(posted?.body, { body: 'still wrong' });
  } finally {
    app.teardown();
  }
});

test('a follow-up error stays on screen with the button live again', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'answered' })] }),
    routes: { 'POST /comments/1/followup': () => ({ status: 500, json: null }) },
  });
  try {
    const thread = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread[data-comment-id="1"]'));
    /** @type {HTMLElement} */ (thread.querySelectorAll('.actions button')[0]).click();
    const followup = /** @type {HTMLElement} */ (thread.querySelector('.thread.composer.followup'));
    /** @type {HTMLTextAreaElement} */ (followup.querySelector('textarea')).value = 'still wrong';
    /** @type {HTMLElement} */ (followup.querySelector('.actions .primary')).click();
    await settle();

    assert.ok(app.document.contains(followup), 'the follow-up box must still be on screen after the error');
    assert.equal(followup.querySelector('.warn')?.textContent, 'Queue failed (500).');
    assert.equal(/** @type {HTMLButtonElement} */ (followup.querySelector('.actions .primary')).disabled, false);
  } finally {
    app.teardown();
  }
});

test('Resolve patches the thread closed', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'answered' })] }),
  });
  try {
    const thread = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread[data-comment-id="1"]'));
    /** @type {HTMLElement} */ (thread.querySelectorAll('.actions button')[1]).click();
    await settle();

    const patched = app.requests.find((r) => r.method === 'PATCH' && r.path === '/comments/1');
    assert.deepEqual(patched?.body, { status: 'resolved' });
  } finally {
    app.teardown();
  }
});
