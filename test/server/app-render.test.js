import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountApp, sessionFixture, fileFixture, hunkFixture, commentFixture, lineFixture,
} from '../helpers/dom.js';

test('the first render loads the session and names the branch', async () => {
  const app = await mountApp({ session: sessionFixture() });
  try {
    assert.equal(app.document.getElementById('ident')?.textContent, 'feat/x → main');
    assert.equal(app.requests[0].method, 'STREAM');
    assert.ok(app.requests.some((r) => r.method === 'GET' && r.path === ''));
  } finally {
    app.teardown();
  }
});

test('every request carries the token from the link', async () => {
  const app = await mountApp({ token: 'zz9' });
  try {
    const loaded = app.requests.find((r) => r.method === 'GET' && r.path === '');
    assert.equal(loaded?.headers['x-cr-token'], 'zz9');
  } finally {
    app.teardown();
  }
});

test('the files nav lists each file, with a diffstat until a comment lands on it', async () => {
  const app = await mountApp({
    session: sessionFixture({
      snapshot: {
        files: [fileFixture({ path: 'src/a.js', added: 4, removed: 2 }), fileFixture({ path: 'gen/b.js', tags: ['generated'] })],
        totals: { files: 2, added: 4, removed: 2 },
      },
      comments: [commentFixture({ file: 'gen/b.js', status: 'open' })],
    }),
  });
  try {
    const buttons = [...app.document.querySelectorAll('#files button')];
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].querySelector('.count')?.textContent, '+4-2');
    assert.equal(buttons[1].querySelector('.count')?.textContent, '1');
    assert.equal(buttons[1].className, 'gen');
    assert.equal(buttons[0].getAttribute('aria-current'), 'true');
  } finally {
    app.teardown();
  }
});

test('a resolved comment does not count against its file', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'resolved' })] }),
  });
  try {
    assert.equal(app.document.querySelector('#files .count')?.textContent, '+1-1');
  } finally {
    app.teardown();
  }
});

test('clicking a file in the nav switches the diff to it', async () => {
  const app = await mountApp({
    session: sessionFixture({
      snapshot: {
        files: [fileFixture({ path: 'src/a.js' }), fileFixture({ path: 'src/b.js' })],
        totals: { files: 2, added: 2, removed: 2 },
      },
    }),
  });
  try {
    const second = /** @type {HTMLElement} */ (app.document.querySelectorAll('#files button')[1]);
    second.click();
    assert.equal(app.document.querySelector('#diff .filehead span')?.textContent, 'src/b.js');
  } finally {
    app.teardown();
  }
});

test('unified rows carry their file, both line numbers and their hunk', async () => {
  const app = await mountApp();
  try {
    const rows = [...app.document.querySelectorAll('#diff .row')];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].getAttribute('data-file'), 'src/a.js');
    assert.equal(rows[0].getAttribute('data-old-line'), '10');
    assert.equal(rows[0].getAttribute('data-new-line'), '10');
    assert.equal(rows[1].getAttribute('data-new-line'), '');
    assert.equal(rows[2].getAttribute('data-old-line'), '');
    assert.equal(rows[0].getAttribute('data-hunk'), '0');
  } finally {
    app.teardown();
  }
});

test('split view pairs a deletion with its addition on one row', async () => {
  const app = await mountApp({ session: sessionFixture({ view: 'split' }) });
  try {
    const pane = /** @type {HTMLElement} */ (app.document.getElementById('diff'));
    assert.ok(pane.classList.contains('split'));
    const paired = [...pane.querySelectorAll('.row.split')].find((row) => (
      row.getAttribute('data-old-line') === '11' && row.getAttribute('data-new-line') === '11'
    ));
    assert.ok(paired, 'the deletion and the addition share one row');
    assert.equal(paired?.querySelectorAll('.t[data-side="old"]').length, 1);
    assert.equal(paired?.querySelectorAll('.t[data-side="new"]').length, 1);
  } finally {
    app.teardown();
  }
});

test('the view toggle names the other view', async () => {
  const app = await mountApp({ session: sessionFixture({ view: 'split' }) });
  try {
    assert.equal(app.document.getElementById('view')?.textContent, 'unified');
  } finally {
    app.teardown();
  }
});

test('a thread lands under the row its range ends on', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'answered', endLine: 11, side: 'new' })] }),
  });
  try {
    const anchor = app.document.querySelector('#diff .row[data-new-line="11"]');
    assert.equal(anchor?.nextElementSibling?.getAttribute('data-comment-id'), '1');
  } finally {
    app.teardown();
  }
});

test('a stale thread shows what it was anchored to', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'stale', quote: 'const b = 2;' })] }),
  });
  try {
    const thread = app.document.querySelector('#diff .thread.stale');
    assert.equal(thread?.querySelector('.was')?.textContent, 'was: const b = 2;');
    assert.equal(thread?.querySelector('.actions'), null);
  } finally {
    app.teardown();
  }
});

test('a session-scope note renders at the end of the pane', async () => {
  const app = await mountApp({
    session: sessionFixture({
      comments: [
        // Line 500 is outside the hunk on purpose, so this thread takes the append fallback.
        commentFixture({ id: 1, status: 'answered', endLine: 500 }),
        commentFixture({ id: 2, scope: 'session', file: null, side: null, startLine: null, endLine: null, status: 'answered' }),
      ],
    }),
  });
  try {
    const notes = app.document.querySelectorAll('#diff .thread.session-scope');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].hasAttribute('data-side'), false);
    const diff = /** @type {HTMLElement} */ (app.document.getElementById('diff'));
    const children = [...diff.children];
    const lastRowIndex = children.reduce((last, child, index) => (
      child.classList.contains('row') ? index : last
    ), -1);
    assert.ok(lastRowIndex !== -1, 'the diff has at least one row to compare against');
    assert.ok(children.indexOf(notes[0]) > lastRowIndex, 'the session-scope note comes after the last row');
    const anchored = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread[data-comment-id="1"]'));
    assert.ok(anchored, 'the line-anchored thread renders too');
    assert.ok(
      children.indexOf(notes[0]) > children.indexOf(anchored),
      'the session-scope note comes after the line-anchored thread',
    );
  } finally {
    app.teardown();
  }
});

test('a thread shows the agent replies it has collected', async () => {
  const app = await mountApp({
    session: sessionFixture({
      comments: [commentFixture({
        status: 'answered',
        replies: [{ role: 'agent', body: 'renamed it', status: 'fixed', at: '', deliveredAt: null }],
      })],
    }),
  });
  try {
    const reply = app.document.querySelector('#diff .thread-replies .reply.agent');
    assert.equal(reply?.querySelector('.who')?.textContent, 'agent · fixed');
    assert.equal(reply?.querySelector('.body')?.textContent, 'renamed it');
  } finally {
    app.teardown();
  }
});

test('the activity badge reports the delivery state and the lease', async () => {
  const app = await mountApp({
    session: sessionFixture({
      comments: [commentFixture({ status: 'sent', deliveredAt: null })],
      lease: { holder: 1, expiresAt: '2099-01-01T00:00:00.000Z' },
    }),
  });
  try {
    const badge = app.document.getElementById('activity');
    assert.equal(badge?.getAttribute('data-delivery'), 'waiting');
    assert.equal(badge?.getAttribute('data-polling'), 'true');
    assert.equal(badge?.querySelector('.label')?.textContent, 'agent listening');
  } finally {
    app.teardown();
  }
});

test('an idle session with no lease shows no activity label', async () => {
  const app = await mountApp();
  try {
    const badge = app.document.getElementById('activity');
    assert.equal(badge?.textContent, '');
    assert.equal(badge?.children.length, 0);
  } finally {
    app.teardown();
  }
});

test('the note keeps the ident in its tooltip alongside what the agent said', async () => {
  const app = await mountApp({ session: sessionFixture({ note: 'fixed the ack' }) });
  try {
    assert.equal(app.document.getElementById('say')?.textContent, 'fixed the ack');
    assert.equal(app.document.getElementById('note')?.title, 'feat/x → main: fixed the ack');
  } finally {
    app.teardown();
  }
});

test('a large file is held back until the human asks for it', async () => {
  const big = fileFixture({ added: 900, removed: 900 });
  const app = await mountApp({ session: sessionFixture({ snapshot: { files: [big], totals: { files: 1, added: 900, removed: 900 } } }) });
  try {
    assert.equal(app.document.querySelector('#diff .large p')?.textContent, '1800 changed lines.');
    assert.equal(app.document.querySelectorAll('#diff .row').length, 0);

    /** @type {HTMLElement} */ (app.document.querySelector('#diff .large button')).click();
    assert.equal(app.document.querySelectorAll('#diff .row').length, 3);
  } finally {
    app.teardown();
  }
});

test('a binary file says so instead of rendering rows', async () => {
  const app = await mountApp({
    session: sessionFixture({
      snapshot: { files: [fileFixture({ binary: true, hunks: [] })], totals: { files: 1, added: 0, removed: 0 } },
    }),
  });
  try {
    assert.equal(app.document.querySelector('#diff .large')?.textContent, 'Binary file, no textual diff.');
  } finally {
    app.teardown();
  }
});

test('a truncated line is marked without corrupting its text', async () => {
  const long = 'x'.repeat(4000);
  const app = await mountApp({
    session: sessionFixture({
      snapshot: {
        files: [fileFixture({ hunks: [hunkFixture({ lines: [lineFixture({ text: long, oldLine: 10, newLine: 10 })] })] })],
        totals: { files: 1, added: 1, removed: 0 },
      },
    }),
  });
  try {
    const cell = app.document.querySelector('#diff .row .t');
    assert.ok(cell?.classList.contains('truncated'));
    assert.equal(cell?.textContent?.includes('line truncated'), false);
  } finally {
    app.teardown();
  }
});

test('a 401 tells the human the link lost its token', async () => {
  const app = await mountApp({ routes: { 'GET ': () => ({ status: 401, json: { error: 'no token' } }) } });
  try {
    assert.equal(
      app.document.getElementById('say')?.textContent,
      'This link is missing its token. Reopen the session from the terminal.',
    );
  } finally {
    app.teardown();
  }
});

test('any other failure reports its status', async () => {
  const app = await mountApp({ routes: { 'GET ': () => ({ status: 500, json: { error: 'boom' } }) } });
  try {
    assert.equal(app.document.getElementById('say')?.textContent, 'Cannot load this session (500).');
  } finally {
    app.teardown();
  }
});
