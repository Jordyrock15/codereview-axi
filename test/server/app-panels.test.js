import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApp, sessionFixture, commentFixture, settle } from '../helpers/dom.js';

/**
 * @returns {import('../../src/types.js').Session}
 */
const withEachStatus = () => sessionFixture({
  comments: [
    commentFixture({ id: 1, status: 'open', body: 'queued one' }),
    commentFixture({ id: 2, status: 'answered', body: 'answered one' }),
    commentFixture({ id: 3, status: 'resolved', body: 'resolved one' }),
  ],
});

/**
 * @param {Document} document
 * @param {string} id
 * @returns {void}
 */
const press = (document, id) => { /** @type {HTMLElement} */ (document.getElementById(id)).click(); };

/**
 * One row per group's distinct copy, so a case that presses one toggle can
 * assert on all three groups' labels and empty text in turn.
 * @type {{toggle: string, title: string, region: string, close: string, empty: string}[]}
 */
const PANEL_CASES = [
  {
    toggle: 'queue-open', title: 'Queue', region: 'Queued comments', close: 'Close queue',
    empty: 'Nothing queued. Draft a comment on the diff and it will show up here before you send it.',
  },
  {
    toggle: 'answered-open', title: 'Answered', region: 'Answered comments', close: 'Close answered comments',
    empty: 'Nothing answered yet. Comments the agent has replied to collect here.',
  },
  {
    toggle: 'resolved-open', title: 'Resolved', region: 'Resolved comments', close: 'Close resolved comments',
    empty: 'Nothing resolved yet. Threads you close with Resolve collect here.',
  },
];

test('the panel starts shut', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
    assert.equal(app.document.getElementById('queue-open')?.getAttribute('aria-expanded'), 'false');
  } finally {
    app.teardown();
  }
});

test('each group names itself in the title, the region and the close button', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    // Queued last: its labels match the shell's static markup already.
    for (const panelCase of [PANEL_CASES[1], PANEL_CASES[2], PANEL_CASES[0]]) {
      press(app.document, panelCase.toggle);
      const panel = /** @type {HTMLElement} */ (app.document.getElementById('queue-panel'));
      assert.equal(panel.hidden, false);
      assert.equal(app.document.getElementById('queue-title')?.textContent, panelCase.title);
      assert.equal(panel.getAttribute('aria-label'), panelCase.region);
      assert.equal(app.document.getElementById('queue-close')?.getAttribute('aria-label'), panelCase.close);
      assert.equal(app.document.getElementById(panelCase.toggle)?.getAttribute('aria-expanded'), 'true');
    }
  } finally {
    app.teardown();
  }
});

test('each group lists only its own comments', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'resolved-open');
    const bodies = [...app.document.querySelectorAll('#queue-list .queue-entry-body')].map((n) => n.textContent);
    assert.deepEqual(bodies, ['resolved one']);
  } finally {
    app.teardown();
  }
});

test('an empty group says what would collect there, and only then', async () => {
  for (const panelCase of PANEL_CASES) {
    const empty = await mountApp({ session: sessionFixture({ comments: [] }) });
    try {
      press(empty.document, panelCase.toggle);
      assert.equal(empty.document.querySelector('#queue-list .queue-empty')?.textContent, panelCase.empty);
    } finally {
      empty.teardown();
    }
  }

  const populated = await mountApp({ session: withEachStatus() });
  try {
    press(populated.document, 'queue-open');
    assert.equal(populated.document.querySelector('#queue-list .queue-empty'), null);
  } finally {
    populated.teardown();
  }
});

test('an entry splits its path so the filename survives', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    const loc = app.document.querySelector('#queue-list .queue-entry-loc');
    assert.equal(loc?.querySelector('.dir')?.textContent, 'src/');
    assert.equal(loc?.querySelector('.base')?.textContent, 'a.js:11');
    assert.equal(/** @type {HTMLElement} */ (loc).title, 'src/a.js:11');
  } finally {
    app.teardown();
  }
});

test('only a queued entry can be withdrawn', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    assert.equal(app.document.querySelectorAll('#queue-list .queue-entry-remove').length, 1);

    press(app.document, 'answered-open');
    assert.equal(app.document.querySelectorAll('#queue-list .queue-entry-remove').length, 0);
  } finally {
    app.teardown();
  }
});

test('Remove deletes the comment and the panel renders the emptied queue', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    /** @type {HTMLElement} */ (app.document.querySelector('#queue-list .queue-entry-remove')).click();
    await settle();

    assert.ok(app.requests.some((r) => r.method === 'DELETE' && r.path === '/comments/1'));
    assert.equal(app.document.getElementById('queue-open')?.textContent, 'Queued 0');
    assert.equal(
      app.document.querySelector('#queue-list .queue-empty')?.textContent,
      'Nothing queued. Draft a comment on the diff and it will show up here before you send it.',
    );
  } finally {
    app.teardown();
  }
});

test('Send belongs to the queue alone', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-send')).hidden, false);

    press(app.document, 'resolved-open');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-send')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('pressing the same toggle twice shuts the panel', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    press(app.document, 'queue-open');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('pressing another toggle switches group rather than shutting', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');

    // A browser click fires mousedown before click, so mimic both.
    const answeredToggle = /** @type {HTMLElement} */ (app.document.getElementById('answered-open'));
    answeredToggle.dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(
      /** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden,
      false,
      'the mousedown on another toggle must not close the panel by itself',
    );
    assert.equal(app.document.getElementById('queue-title')?.textContent, 'Queue');

    answeredToggle.click();
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, false);
    assert.equal(app.document.getElementById('queue-title')?.textContent, 'Answered');
    assert.equal(app.document.getElementById('queue-open')?.getAttribute('aria-expanded'), 'false');
  } finally {
    app.teardown();
  }
});

test('a click outside shuts the panel', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    app.document.getElementById('diff')?.dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('a click inside the panel leaves it open', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    app.document.getElementById('queue-list')?.dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, false);
  } finally {
    app.teardown();
  }
});

test('the close button shuts the panel', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    press(app.document, 'queue-close');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('Escape shuts the panel and leaves an open composer and its pick alone, until a second Escape clears them', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    const row = /** @type {HTMLElement} */ (app.document.querySelector('#diff .row[data-new-line="10"]'));
    /** @type {HTMLElement} */ (row.querySelectorAll('.n')[1]).dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    const text = /** @type {HTMLTextAreaElement} */ (app.document.querySelector('#diff .thread.composer textarea'));
    text.value = 'half a thought';
    text.dispatchEvent(new app.window.Event('input'));
    press(app.document, 'queue-open');

    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
    const composer = app.document.querySelector('#diff .thread.composer');
    assert.ok(composer && app.document.contains(composer), 'the composer survives the first Escape');
    assert.equal(
      composer?.querySelector('textarea'),
      text,
      'the composer must be reused, not rebuilt, across the first Escape',
    );
    assert.equal(text.value, 'half a thought', 'the draft text must survive the first Escape');
    assert.equal(
      app.document.querySelectorAll('#diff .row.picked').length,
      1,
      'the picked row must still be marked after the first Escape',
    );

    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
    assert.equal(app.document.querySelectorAll('#diff .row.picked').length, 0, 'the second Escape clears the pick');
  } finally {
    app.teardown();
  }
});

test("the panel's Send sends, empties the queue count, and then shuts the panel", async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    press(app.document, 'queue-send');
    await settle();

    assert.ok(app.requests.some((r) => r.method === 'POST' && r.path === '/send'));
    assert.equal(app.document.getElementById('queue-open')?.textContent, 'Queued 0');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('an entry click scrolls to its own thread and shuts the panel', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ id: 1, status: 'answered' })] }),
  });
  try {
    press(app.document, 'answered-open');

    const thread = /** @type {HTMLElement} */ (app.document.querySelector('[data-comment-id="1"]'));
    let scrolled = false;
    thread.scrollIntoView = () => { scrolled = true; };

    /** @type {HTMLElement} */ (app.document.querySelector('#queue-list .queue-entry-open')).click();

    assert.equal(scrolled, true, 'the click must scroll the matching thread, not merely close the panel');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});
