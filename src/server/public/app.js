/**
 * @typedef {import('../../types.js').Session} Session
 * @typedef {import('../../types.js').SnapshotFile} SnapshotFile
 * @typedef {import('../../types.js').Hunk} Hunk
 * @typedef {import('../../types.js').DiffLine} DiffLine
 * @typedef {import('../../types.js').Comment} Comment
 */

import { highlight } from './highlight.js';

const key = document.body.dataset.key;
const token = new URLSearchParams(location.search).get('t') ?? '';

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
const api = (path, options = {}) => fetch(`/api/sessions/${key}${path}`, {
  ...options,
  headers: { 'x-cr-token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
});

// A junk or missing dataset value must not silently disable the large-file guard.
const parsedLarge = Number(document.body.dataset.large ?? 1500);
const LARGE = Number.isFinite(parsedLarge) && parsedLarge > 0 ? parsedLarge : 1500;

/** @type {{session: Session|null, current: string|null}} */
const view = { session: null, current: null };

/** Paths the human chose to render despite the large-file guard. @type {Set<string>} */
const forced = new Set();

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** @type {{file: string|null, side: 'old'|'new', start: number|null, end: number|null}} */
const picking = { file: null, side: 'new', start: null, end: null };

/**
 * In-progress composer text survives a re-render only if it is kept outside
 * the DOM the render wipes. Keyed by file, side and the range's start line,
 * not the end: a shift-extend changes `picking.end` without rebuilding the
 * composer, so keying on the end too would silently fork a single in-progress
 * draft into two map entries, the older of which `clearPick` would never
 * reach. A different pick (different file, side or start line) still gets
 * its own entry and never inherits someone else's draft.
 * @type {Map<string, {text: string, selStart: number, selEnd: number}>}
 */
const drafts = new Map();

/** @returns {string} */
const draftKey = () => `${picking.file}::${picking.side}::${picking.start}`;

/** @returns {void} */
const clearPick = () => {
  if (picking.file !== null) drafts.delete(draftKey());
  picking.file = null;
  picking.start = null;
  picking.end = null;
  document.querySelector('.thread.composer')?.remove();
  for (const row of document.querySelectorAll('.row.picked')) row.classList.remove('picked');
};

/** @returns {void} */
const paintPick = () => {
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.row'))) {
    const line = Number(row.dataset[picking.side === 'new' ? 'newLine' : 'oldLine'] || 0);
    const inRange = picking.start !== null && line >= Math.min(picking.start, picking.end ?? picking.start)
      && line <= Math.max(picking.start, picking.end ?? picking.start);
    row.classList.toggle('picked', inRange && row.dataset.file === picking.file);
  }
};

/** @returns {void} */
const counts = () => {
  const comments = view.session?.comments ?? [];
  const unsent = comments.filter((c) => ['open', 'reopened'].includes(c.status)).length;
  const answered = comments.filter((c) => c.status === 'answered').length;
  const stale = comments.filter((c) => c.status === 'stale').length;

  $('counts').textContent = `${unsent} unsent · ${answered} answered · ${stale} stale`;
  const send = /** @type {HTMLButtonElement} */ ($('send'));
  send.disabled = unsent === 0;
  send.textContent = unsent === 0 ? 'Send' : `Send ${unsent}`;
};

/** @returns {void} */
const renderFiles = () => {
  const session = /** @type {Session} */ (view.session);
  const nav = $('files');
  nav.replaceChildren();

  for (const file of session.snapshot.files) {
    const open = session.comments.filter((c) => c.file === file.path && c.status !== 'resolved').length;
    const button = el('button', file.tags.includes('generated') ? 'gen' : '');
    button.append(el('span', 'path', file.path));
    button.append(el('span', 'count', open === 0 ? `+${file.added} -${file.removed}` : String(open)));
    button.setAttribute('aria-current', String(file.path === view.current));
    button.addEventListener('click', () => { view.current = file.path; renderDiff(); renderFiles(); });
    nav.append(button);
  }
};

/**
 * The exact source text of the selected lines: this is what re-anchoring
 * later relies on to find the comment again after the code has moved.
 * @param {SnapshotFile} file
 * @returns {string}
 */
const quoteFor = (file) => {
  const from = Math.min(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
  const to = Math.max(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
  /** @type {string[]} */
  const texts = [];

  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      const number = picking.side === 'new' ? l.newLine : l.oldLine;
      if (number !== null && number >= from && number <= to) texts.push(l.text);
    }
  }
  return texts.join('\n');
};

/**
 * @param {SnapshotFile} file
 * @param {HTMLElement} afterRow
 * @returns {void}
 */
const openComposer = (file, afterRow) => {
  document.querySelector('.thread.composer')?.remove();

  const box = el('div', 'thread composer');
  const from = Math.min(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
  const to = Math.max(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
  box.append(el('div', 'who', `New comment · ${file.path} · ${from === to ? `line ${from}` : `lines ${from}-${to}`}`));

  const text = document.createElement('textarea');
  text.placeholder = 'What is wrong, and what should change';
  box.append(text);

  const draft = drafts.get(draftKey());
  if (draft) text.value = draft.text;

  text.addEventListener('input', () => {
    drafts.set(draftKey(), { text: text.value, selStart: text.selectionStart, selEnd: text.selectionEnd });
  });

  let verdict = 'fix';
  const verdicts = el('div', 'verdicts');
  for (const option of ['fix', 'explain', 'ignore']) {
    const button = el('button', '', option);
    button.setAttribute('aria-pressed', String(option === verdict));
    button.addEventListener('click', () => {
      verdict = option;
      for (const other of verdicts.children) other.setAttribute('aria-pressed', String(other.textContent === option));
    });
    verdicts.append(button);
  }
  box.append(verdicts);

  const actions = el('div', 'actions');
  const save = /** @type {HTMLButtonElement} */ (el('button', '', 'Save'));
  const cancel = el('button', '', 'Cancel');

  save.addEventListener('click', async () => {
    if (text.value.trim() === '') { text.focus(); return; }
    save.disabled = true;

    const res = await api('/comments', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'line', file: file.path, side: picking.side,
        startLine: from, endLine: to, quote: quoteFor(file), body: text.value, verdict,
      }),
    });

    if (!res.ok) { save.disabled = false; return; }
    box.remove();
    clearPick();
    await load();
  });

  cancel.addEventListener('click', () => { box.remove(); clearPick(); });
  actions.append(save, cancel);
  box.append(actions);

  afterRow.after(box);
  text.focus();
  if (draft) text.setSelectionRange(draft.selStart, draft.selEnd);
};

/**
 * Shift-extending a range must not rebuild the composer, or the human's
 * in-progress text is lost along with the textarea.
 * @param {HTMLElement} box
 * @param {SnapshotFile} file
 * @returns {void}
 */
const updateComposerHeader = (box, file) => {
  const from = Math.min(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
  const to = Math.max(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
  const who = box.querySelector('.who');
  if (who) who.textContent = `New comment · ${file.path} · ${from === to ? `line ${from}` : `lines ${from}-${to}`}`;
};

/**
 * @param {Comment} comment
 * @returns {HTMLElement}
 */
const threadFor = (comment) => {
  const box = el('div', `thread ${comment.status}`);

  if (comment.status === 'answered' || comment.status === 'resolved') {
    box.append(el('span', '', `${comment.status === 'resolved' ? 'Resolved' : 'Answered'} · ${comment.agentReply?.status ?? ''}: ${comment.agentReply?.body ?? ''}`));
    const actions = el('span', 'actions');
    const reopen = el('button', '', 'Reopen');
    reopen.addEventListener('click', () => patch(comment.id, { status: 'reopened' }));
    actions.append(reopen);

    if (comment.status === 'answered') {
      const resolve = el('button', '', 'Resolve');
      resolve.addEventListener('click', () => patch(comment.id, { status: 'resolved' }));
      actions.append(resolve);
    }
    box.append(actions);
    return box;
  }

  box.append(el('div', 'who', `${comment.status} · ${comment.verdict}`));
  box.append(el('div', 'body', comment.body));

  if (comment.status === 'stale') {
    box.append(el('div', 'was', `was: ${comment.quote}`));
    const actions = el('span', 'actions');
    const reopen = el('button', '', 'Reopen');
    reopen.addEventListener('click', () => patch(comment.id, { status: 'reopened' }));
    actions.append(reopen);
    box.append(actions);
  }

  return box;
};

/**
 * @param {number} id
 * @param {{status: string}} body
 * @returns {Promise<void>}
 */
const patch = async (id, body) => {
  await api(`/comments/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  await load();
};

/**
 * @param {HTMLElement} pane
 * @param {SnapshotFile} file
 * @returns {void}
 */
const renderThreadsImpl = (pane, file) => {
  for (const comment of view.session?.comments ?? []) {
    if (comment.file !== file.path) continue;

    if (comment.status === 'stale' || comment.startLine === null) {
      pane.append(threadFor(comment));
      continue;
    }

    const rows = [.../** @type {NodeListOf<HTMLElement>} */ (pane.querySelectorAll('.row'))];
    const anchor = rows.reverse().find((row) => (
      Number(row.dataset[comment.side === 'new' ? 'newLine' : 'oldLine'] || 0) === comment.endLine
    ));

    if (anchor) {
      anchor.after(threadFor(comment));
    } else {
      pane.append(threadFor(comment));
    }
  }

  for (const comment of (view.session?.comments ?? []).filter((c) => c.scope === 'session')) {
    const box = threadFor(comment);
    box.classList.add('session-scope');
    pane.append(box);
  }
};

/**
 * @param {SnapshotFile} file
 * @param {DiffLine} line0
 * @returns {HTMLElement}
 */
const renderRow = (file, line0) => {
  const row = el('div', `row ${line0.kind}`);
  const oldNo = el('span', 'n', line0.oldLine === null ? '' : String(line0.oldLine));
  const newNo = el('span', 'n', line0.newLine === null ? '' : String(line0.newLine));
  const cell = el('span', 't');
  cell.innerHTML = highlight(line0.text);
  row.append(oldNo, newNo, cell);

  row.dataset.file = file.path;
  row.dataset.newLine = String(line0.newLine ?? '');
  row.dataset.oldLine = String(line0.oldLine ?? '');

  const pick = (/** @type {'old'|'new'} */ side) => (/** @type {MouseEvent} */ event) => {
    const line = Number(side === 'new' ? line0.newLine : line0.oldLine);
    if (!Number.isInteger(line) || line === 0) return;

    // The side must match too: the old and new gutters are adjacent columns, so
    // extending across them would build a quote for code the human never chose.
    const shiftExtend = event.shiftKey && picking.start !== null && picking.file === file.path && side === picking.side;

    if (shiftExtend) {
      picking.end = line;
    } else {
      picking.file = file.path;
      picking.side = side;
      picking.start = line;
      picking.end = line;
    }
    paintPick();

    const existingComposer = /** @type {HTMLElement|null} */ (document.querySelector('.thread.composer'));
    if (shiftExtend && existingComposer) {
      updateComposerHeader(existingComposer, file);
    } else {
      openComposer(file, row);
    }
  };

  oldNo.addEventListener('click', pick('old'));
  newNo.addEventListener('click', pick('new'));

  return row;
};

/** @returns {void} */
const renderDiff = () => {
  const session = /** @type {Session} */ (view.session);
  const pane = $('diff');
  pane.replaceChildren();

  const file = session.snapshot.files.find((f) => f.path === view.current);
  if (!file) return;

  const head = el('div', 'filehead');
  head.append(el('span', '', file.path), el('span', '', `+${file.added} -${file.removed}`));
  pane.append(head);

  if (file.binary) {
    pane.append(el('p', 'large', 'Binary file, no textual diff.'));
    return;
  }

  if (file.added + file.removed > LARGE && !forced.has(file.path)) {
    const warn = el('div', 'large');
    warn.append(el('p', '', `${file.added + file.removed} changed lines.`));
    const button = el('button', '', 'Render anyway');
    button.addEventListener('click', () => { forced.add(file.path); renderDiff(); });
    warn.append(button);
    pane.append(warn);
    return;
  }

  for (const hunk of file.hunks) {
    const expand = el('button', 'expand', `⋯ ${hunk.header || `line ${hunk.newStart}`} ⋯`);
    expand.addEventListener('click', () => expandAbove(file, hunk, pane, expand));
    pane.append(expand);
    for (const line of hunk.lines) pane.append(renderRow(file, line));
  }

  renderThreadsImpl(pane, file);
  reopenComposerIfPicking(pane, file);
};

/**
 * `replaceChildren` above destroys any open composer along with its
 * in-progress text. If the human was still picking a range in this file when
 * the re-render happened (an SSE event, most likely), put it back.
 * @param {HTMLElement} pane
 * @param {SnapshotFile} file
 * @returns {void}
 */
const reopenComposerIfPicking = (pane, file) => {
  if (picking.file !== file.path || picking.end === null) return;

  const rows = [.../** @type {NodeListOf<HTMLElement>} */ (pane.querySelectorAll('.row'))];
  const anchor = rows.reverse().find((row) => (
    Number(row.dataset[picking.side === 'new' ? 'newLine' : 'oldLine'] || 0) === picking.end
  ));
  if (!anchor) return;

  paintPick();
  openComposer(file, anchor);
};

/**
 * @param {SnapshotFile} file
 * @param {Hunk} hunk
 * @param {HTMLElement} pane
 * @param {HTMLElement} anchor
 * @returns {Promise<void>}
 */
const expandAbove = async (file, hunk, pane, anchor) => {
  const from = Math.max(1, hunk.newStart - 8);
  const res = await api(`/context?file=${encodeURIComponent(file.path)}&from=${from}&to=${hunk.newStart - 1}`);
  if (!res.ok) return;

  const { lines, from: start } = await res.json();
  const rows = lines.map((/** @type {string} */ text, /** @type {number} */ i) => renderRow(file, {
    kind: /** @type {'context'} */ ('context'), text, oldLine: null, newLine: start + i,
  }));
  anchor.replaceWith(...rows);
};

/** @returns {Promise<void>} */
const send = async () => {
  const res = await api('/send', { method: 'POST', body: JSON.stringify({}) });
  if (res.ok) await load();
};

/** @returns {Promise<void>} */
const done = async () => {
  // Closing is irreversible: a closed session's comments and replies are not kept.
  if (!window.confirm("End this review? The session's comments and replies will not be kept.")) return;

  const res = await api('/close', { method: 'POST', body: JSON.stringify({ closedBy: 'human' }) });
  await load();

  // Never claim the session closed unless the server agreed.
  if (!res.ok) return;

  /** @type {HTMLButtonElement} */ ($('send')).disabled = true;
  /** @type {HTMLButtonElement} */ ($('done')).disabled = true;
  $('note').textContent = 'Session closed. You can close this tab.';
};

/** @returns {void} */
const subscribe = () => {
  const badge = $('stream');
  const source = new EventSource(`/api/sessions/${key}/stream?t=${encodeURIComponent(token)}`);

  source.addEventListener('open', () => { badge.textContent = 'connected'; badge.dataset.state = 'up'; });
  source.addEventListener('error', () => { badge.textContent = 'disconnected'; badge.dataset.state = 'down'; });
  for (const name of ['comment', 'sent', 'refreshed', 'closed', 'note']) {
    source.addEventListener(name, () => { void load(); });
  }
};

/** @returns {Promise<void>} */
const load = async () => {
  const res = await api('');
  if (!res.ok) {
    $('note').textContent = res.status === 401
      ? 'This link is missing its token. Reopen the session from the terminal.'
      : `Cannot load this session (${res.status}).`;
    return;
  }

  const session = await res.json();
  view.session = session;
  view.current ??= session.snapshot.files[0]?.path ?? null;
  $('note').textContent = session.note || 'no note';
  renderFiles();
  renderDiff();
  counts();
};

$('send').addEventListener('click', send);
$('done').addEventListener('click', done);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') clearPick(); });

subscribe();
await load();
