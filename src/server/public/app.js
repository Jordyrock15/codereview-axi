/**
 * @typedef {import('../../types.js').Session} Session
 * @typedef {import('../../types.js').SnapshotFile} SnapshotFile
 * @typedef {import('../../types.js').Hunk} Hunk
 * @typedef {import('../../types.js').DiffLine} DiffLine
 * @typedef {import('../../types.js').Comment} Comment
 */

import { renderLine } from './highlight.js';
import { pairLines } from './pair.js';
import { activityState } from './activity.js';
import {
  overlayVisible, remainingVisibleMs, OVERLAY_SHOW_DELAY_MS, OVERLAY_MIN_VISIBLE_MS,
  OVERLAY_REFRESHED_SHOW_DELAY_MS, OVERLAY_REFRESHED_MIN_VISIBLE_MS,
} from './overlay.js';
import { queueEntries, groupEntries, GROUPS } from './queue.js';
import { splitPathLabel } from './path-label.js';

const key = document.body.dataset.key;
const token = new URLSearchParams(location.search).get('t') ?? '';

/**
 * Shared by the composer's save-path guard and a shift-click that fails the
 * same-hunk or same-side test: both reject for the same reason, so they show
 * the same words.
 */
const HUNK_BOUNDARY_MSG = 'Selection crosses a hunk boundary. Pick a single unbroken range and try again.';

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

/** @type {{file: string|null, side: 'old'|'new', start: number|null, end: number|null, hunk: string|null}} */
const picking = { file: null, side: 'new', start: null, end: null, hunk: null };

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
  picking.hunk = null;
  document.querySelector('.thread.composer')?.remove();
  for (const row of document.querySelectorAll('.row.picked')) row.classList.remove('picked');
  for (const cell of document.querySelectorAll('.t.picked')) cell.classList.remove('picked');
};

/**
 * Unified marks the whole row; split marks only the cell on the picked side,
 * so choosing a line never highlights the other column's unrelated code.
 * @returns {void}
 */
const paintPick = () => {
  for (const row of document.querySelectorAll('.row.picked')) row.classList.remove('picked');
  for (const cell of document.querySelectorAll('.t.picked')) cell.classList.remove('picked');

  for (const row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.row'))) {
    if (row.dataset.file !== picking.file) continue;

    const line = Number(row.dataset[picking.side === 'new' ? 'newLine' : 'oldLine'] || 0);
    const inRange = picking.start !== null && line >= Math.min(picking.start, picking.end ?? picking.start)
      && line <= Math.max(picking.start, picking.end ?? picking.start);
    if (!inRange) continue;

    if (row.classList.contains('split')) {
      row.querySelector(`.t[data-side="${picking.side}"]`)?.classList.add('picked');
    } else {
      row.classList.add('picked');
    }
  }
};

/** @returns {void} */
const counts = () => {
  const comments = view.session?.comments ?? [];
  const unsent = comments.filter((c) => c.status === 'open').length;
  const answered = comments.filter((c) => c.status === 'answered').length;
  const stale = comments.filter((c) => c.status === 'stale').length;

  const resolved = comments.filter((c) => c.status === 'resolved').length;

  // unsent and answered are the Queued and Answered buttons' own numbers, so
  // only stale is left to report as text, and only when there is any.
  $('counts-unsent').textContent = stale === 0 ? '' : `${stale} stale`;
  $('counts-rest').textContent = '';
  $('queue-open').textContent = `Queued ${unsent}`;
  $('answered-open').textContent = `Answered ${answered}`;
  $('resolved-open').textContent = `Resolved ${resolved}`;
  const send = /** @type {HTMLButtonElement} */ ($('send'));
  send.disabled = unsent === 0;
  send.textContent = unsent === 0 ? 'Send' : `Send ${unsent}`;
  const queueSend = /** @type {HTMLButtonElement} */ ($('queue-send'));
  queueSend.disabled = unsent === 0;
  queueSend.textContent = unsent === 0 ? 'Send' : `Send ${unsent}`;
};

/**
 * Which group the panel is showing, or null when it is shut. Survives a
 * re-render like `view.current` does.
 * @type {keyof typeof GROUPS | null}
 */
let panelGroup = null;

/** @type {Record<keyof typeof GROUPS, {toggle: string, title: string, region: string, close: string, empty: string}>} */
const PANELS = {
  queued: {
    toggle: 'queue-open',
    title: 'Queue',
    region: 'Queued comments',
    close: 'Close queue',
    empty: 'Nothing queued. Draft a comment on the diff and it will show up here before you send it.',
  },
  answered: {
    toggle: 'answered-open',
    title: 'Answered',
    region: 'Answered comments',
    close: 'Close answered comments',
    empty: 'Nothing answered yet. Comments the agent has replied to collect here.',
  },
  resolved: {
    toggle: 'resolved-open',
    title: 'Resolved',
    region: 'Resolved comments',
    close: 'Close resolved comments',
    empty: 'Nothing resolved yet. Threads you close with Resolve collect here.',
  },
};

/** @returns {boolean} */
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {Event} event
 * @returns {void}
 */
const onQueueOutsideClick = (event) => {
  const panel = $('queue-panel');
  const target = /** @type {Node|null} */ (event.target);
  if (!target) return;
  if (panel.contains(target)) return;
  // Every toggle, not just the queue's: clicking one while another group is
  // showing has to switch groups rather than be treated as an outside click.
  if (Object.values(PANELS).some((p) => $(p.toggle).contains(target))) return;
  closeQueuePanel();
};

/**
 * @param {import('./queue.js').QueueEntry} entry
 * @param {boolean} removable
 * @returns {HTMLElement}
 */
const queueEntryEl = (entry, removable) => {
  const row = el('div', 'queue-entry');

  const open = /** @type {HTMLButtonElement} */ (el('button', 'queue-entry-open'));
  open.type = 'button';
  open.append(
    el('span', 'queue-entry-loc', entry.location),
    el('span', 'queue-entry-verdict', entry.verdict),
    el('span', 'queue-entry-body', entry.body),
  );
  open.addEventListener('click', () => { scrollToComment(entry.id); closeQueuePanel(); });

  // Only a queued comment can be withdrawn; an answered or resolved one has
  // already been sent, and deleting it would drop the agent's reply with it.
  if (!removable) {
    row.append(open);
    return row;
  }

  const remove = /** @type {HTMLButtonElement} */ (el('button', 'queue-entry-remove', 'Remove'));
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove the comment on ${entry.location || 'this note'} from the queue`);
  remove.addEventListener('click', async (event) => {
    event.stopPropagation();
    remove.disabled = true;
    await api(`/comments/${entry.id}`, { method: 'DELETE' });
    await load();
  });

  row.append(open, remove);
  return row;
};

/** @returns {void} */
const renderQueuePanel = () => {
  const panel = $('queue-panel');
  const list = $('queue-list');
  list.replaceChildren();

  const group = panelGroup ?? 'queued';
  const config = PANELS[group];
  $('queue-title').textContent = config.title;

  // One panel serves three groups, so the region and its close button have to be
  // relabelled with it: left static, a screen reader announced "Queued comments"
  // while the answered list was on screen. Named per group rather than made
  // generic, so what is announced matches what is shown.
  $('queue-panel').setAttribute('aria-label', config.region);
  $('queue-close').setAttribute('aria-label', config.close);

  const entries = view.session ? groupEntries(view.session, GROUPS[group]) : [];
  if (entries.length === 0) {
    list.append(el('p', 'queue-empty', config.empty));
  } else {
    for (const entry of entries) list.append(queueEntryEl(entry, group === 'queued'));
  }

  // Send belongs to the queue: there is nothing to send from the other groups.
  $('queue-send').hidden = group !== 'queued';

  panel.hidden = panelGroup === null;
  for (const [name, panelConfig] of Object.entries(PANELS)) {
    $(panelConfig.toggle).setAttribute('aria-expanded', String(panelGroup === name));
  }
};

/**
 * @param {keyof typeof GROUPS} group
 * @returns {void}
 */
const openQueuePanel = (group) => {
  panelGroup = group;
  renderQueuePanel();
  document.addEventListener('mousedown', onQueueOutsideClick);
};

/** @returns {void} */
const closeQueuePanel = () => {
  panelGroup = null;
  renderQueuePanel();
  document.removeEventListener('mousedown', onQueueOutsideClick);
};

/**
 * @param {keyof typeof GROUPS} group
 * @returns {void}
 */
const toggleQueuePanel = (group) => {
  if (panelGroup === group) closeQueuePanel();
  else openQueuePanel(group);
};

/**
 * Switches to the comment's file if needed (the same path the files-nav
 * click handler takes) and scrolls its thread into view.
 * @param {number} id
 * @returns {void}
 */
const scrollToComment = (id) => {
  const comment = view.session?.comments.find((c) => c.id === id);
  if (!comment) return;

  if (comment.file !== null && comment.file !== view.current) {
    view.current = comment.file;
    renderFiles();
    renderDiff();
  }

  const target = document.querySelector(`[data-comment-id="${id}"]`);
  target?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
};

/**
 * `delivery` and `polling` are independent, not ranked: a lease can be held
 * during any delivery state, most usefully during `waiting`, so this maps
 * the pair to one label rather than picking a single "most urgent" state.
 * @returns {void}
 */
const renderActivity = () => {
  const node = $('activity');
  if (!view.session) { node.replaceChildren(); return; }

  const state = activityState(view.session);
  node.dataset.delivery = state.delivery;
  node.dataset.polling = String(state.polling);

  const label = state.delivery === 'waiting'
    ? (state.polling ? 'agent connecting' : 'waiting for agent')
    : state.delivery === 'working'
      ? (state.polling ? 'agent working' : 'agent has it')
      : (state.polling ? 'agent connected' : '');

  node.replaceChildren();
  if (label) node.append(el('span', 'dot'), el('span', 'label', label));
};

/** @returns {void} */
const renderFiles = () => {
  const session = /** @type {Session} */ (view.session);
  const nav = $('files');
  nav.replaceChildren();

  for (const file of session.snapshot.files) {
    const open = session.comments.filter((c) => c.file === file.path && c.status !== 'resolved').length;
    const button = el('button', file.tags.includes('generated') ? 'gen' : '');
    const { dir, base } = splitPathLabel(file.path);
    const label = el('span', 'path');
    if (dir) label.append(el('span', 'dir', dir));
    label.append(el('span', 'base', base));
    button.append(label);
    const count = el('span', 'count');
    if (open === 0) {
      count.append(el('span', 'added', `+${file.added}`), el('span', 'removed', `-${file.removed}`));
    } else {
      count.textContent = String(open);
    }
    button.append(count);
    button.title = file.path;
    button.setAttribute('aria-current', String(file.path === view.current));
    button.addEventListener('click', () => { view.current = file.path; renderDiff(); renderFiles(); });
    nav.append(button);
  }
};

/**
 * @param {HTMLElement} pane
 * @returns {HTMLElement[]}
 */
const selectionRows = (pane) => [.../** @type {NodeListOf<HTMLElement>} */ (pane.querySelectorAll('.row'))];

/**
 * The unified view has one text cell per row. Split view has two; read the
 * one whose data-side matches.
 * @param {HTMLElement} row
 * @param {'old'|'new'} side
 * @returns {string}
 */
const textOf = (row, side) => row.querySelector(`.t[data-side="${side}"]`)?.textContent
  ?? row.querySelector('.t')?.textContent ?? '';

/**
 * The rows are what the human saw and chose. Reading the quote from them rather
 * than from file.hunks is what makes expanded context and hunk edges correct.
 *
 * Contiguity is judged by hunk membership, not by adjacency within the row
 * list: a deleted line has no new-side number and so is skipped when building
 * a new-side quote, but that skip does not break contiguity, the deleted text
 * is genuinely absent from the new file. What does break it is a range that
 * reaches into a different hunk, since the lines omitted between two hunks
 * are real, unselected lines the quote would otherwise silently drop.
 * @param {'old'|'new'} side
 * @param {number} from
 * @param {number} to
 * @returns {{quote: string, contiguous: boolean, rowCount: number}}
 */
const quoteFromRows = (side, from, to) => {
  const rows = selectionRows($('diff'));
  const key = side === 'new' ? 'newLine' : 'oldLine';

  /** @type {number[]} */
  const chosen = [];
  for (let i = 0; i < rows.length; i += 1) {
    const n = Number(rows[i].dataset[key] || 0);
    if (Number.isInteger(n) && n >= from && n <= to) chosen.push(i);
  }

  const contiguous = chosen.length > 0 && chosen.every((index) => rows[index].dataset.hunk === rows[chosen[0]].dataset.hunk);
  const quote = chosen.map((i) => textOf(rows[i], side)).join('\n');
  return { quote, contiguous, rowCount: chosen.length };
};

/**
 * @param {SnapshotFile} file
 * @param {HTMLElement} afterRow
 * @returns {void}
 */
const openComposer = (file, afterRow) => {
  document.querySelector('.thread.composer')?.remove();

  const box = el('div', 'thread composer');
  box.dataset.side = picking.side;
  const from = Math.min(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
  const to = Math.max(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
  box.append(el('div', 'who', `Annotate ${file.path}:${from === to ? from : `${from}-${to}`}`));

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

  const warn = el('div', 'warn');
  box.append(warn);

  const actions = el('div', 'actions');
  const save = /** @type {HTMLButtonElement} */ (el('button', 'primary', 'Queue'));
  const cancel = el('button', '', 'Cancel');

  save.addEventListener('click', async () => {
    if (text.value.trim() === '') { text.focus(); return; }

    // Read live: a shift-extend since the composer opened only moves
    // picking.end, it does not rebuild this handler's closure.
    const start = Math.min(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
    const end = Math.max(/** @type {number} */ (picking.start), /** @type {number} */ (picking.end));
    const { quote, contiguous, rowCount } = quoteFromRows(picking.side, start, end);

    // A blank quote is not itself an error, a genuinely blank line is a
    // legitimate one-line quote. Only no matching rows, or rows split across
    // a hunk boundary, mean the selection cannot be saved.
    if (rowCount === 0) {
      warn.textContent = 'No lines are selected. Pick a range and try again.';
      return;
    }
    // Unreachable today: pickHandler refuses to extend a selection across a
    // hunk or side boundary, so quoteFromRows never sees a broken range here.
    // Kept as defence in depth against a future caller that builds a quote
    // without going through pickHandler's gating.
    if (!contiguous) {
      warn.textContent = HUNK_BOUNDARY_MSG;
      return;
    }

    save.disabled = true;

    const res = await api('/comments', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'line', file: file.path, side: picking.side,
        startLine: start, endLine: end, quote, body: text.value, verdict,
      }),
    });

    if (!res.ok) {
      save.disabled = false;
      const problem = await res.json().catch(() => null);
      warn.textContent = problem?.error ?? `Queue failed (${res.status}).`;
      return;
    }
    box.remove();
    clearPick();
    await load();
  });

  cancel.addEventListener('click', () => { box.remove(); clearPick(); });
  actions.append(cancel, save);
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
  if (who) who.textContent = `Annotate ${file.path}:${from === to ? from : `${from}-${to}`}`;

  // A restart note from an earlier rejected shift-click must not linger past
  // the next successful pick, and this is the only path a successful
  // shift-extend takes: it does not recreate the composer's warn div.
  const warn = box.querySelector('.warn');
  if (warn) warn.textContent = '';
};

/**
 * One message below the opening comment, human and agent visually distinct.
 * @param {import('../../types.js').Message} message
 * @returns {HTMLElement}
 */
const replyEl = (message) => {
  const row = el('div', `reply ${message.role}`);
  const label = message.role === 'agent' ? `agent · ${message.status ?? ''}` : 'human';
  row.append(el('div', 'who', label), el('div', 'body', message.body));
  return row;
};

/**
 * The trailing messages a long thread would otherwise blow the diff layout
 * open for: capped and scrollable rather than truncated, so nothing said is
 * ever lost, it just takes a scroll to reach.
 * @param {import('../../types.js').Message[]} replies
 * @returns {HTMLElement}
 */
const repliesEl = (replies) => {
  const wrap = el('div', 'thread-replies');
  for (const message of replies) wrap.append(replyEl(message));
  return wrap;
};

/**
 * Replaces the Reopen button on an answered thread: a fresh textarea posting
 * new text, rather than resending the same body.
 * @param {number} id
 * @returns {HTMLElement}
 */
const followupComposer = (id) => {
  const box = el('div', 'thread composer followup');
  const text = document.createElement('textarea');
  text.placeholder = 'Say more, ask something else, or point out what is still wrong';
  box.append(text);

  const warn = el('div', 'warn');
  const actions = el('div', 'actions');
  const save = /** @type {HTMLButtonElement} */ (el('button', 'primary', 'Queue'));
  const cancel = el('button', '', 'Cancel');

  save.addEventListener('click', async () => {
    if (text.value.trim() === '') { text.focus(); return; }
    save.disabled = true;
    const res = await api(`/comments/${id}/followup`, { method: 'POST', body: JSON.stringify({ body: text.value }) });
    if (!res.ok) {
      save.disabled = false;
      const problem = await res.json().catch(() => null);
      warn.textContent = problem?.error ?? `Queue failed (${res.status}).`;
      return;
    }
    await load();
  });
  cancel.addEventListener('click', () => { box.remove(); });

  actions.append(cancel, save);
  box.append(warn, actions);
  return box;
};

/**
 * @param {Comment} comment
 * @returns {HTMLElement}
 */
const threadFor = (comment) => {
  const box = el('div', `thread ${comment.status}`);
  box.dataset.commentId = String(comment.id);
  // Session-scope notes have no side (they are not anchored to a line), so
  // they keep the base offset rather than being pinned to an arbitrary pane.
  if (comment.side !== null) box.dataset.side = comment.side;

  box.append(el('div', 'who', `${comment.status} · ${comment.verdict}`));
  box.append(el('div', 'body', comment.body));

  if (comment.replies.length > 0) box.append(repliesEl(comment.replies));

  if (comment.status === 'stale') {
    box.append(el('div', 'was', `was: ${comment.quote}`));
    return box;
  }

  if (comment.status === 'answered' || comment.status === 'resolved') {
    const actions = el('span', 'actions');
    if (comment.status === 'answered') {
      const reply = el('button', '', 'Reply');
      reply.addEventListener('click', () => {
        box.querySelector('.thread.composer.followup')?.remove();
        const composer = followupComposer(comment.id);
        box.append(composer);
        composer.querySelector('textarea')?.focus();
      });
      const resolve = el('button', '', 'Resolve');
      resolve.addEventListener('click', () => patch(comment.id, { status: 'resolved' }));
      actions.append(reply, resolve);
    }
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
 * Selection logic for a gutter click, shared by the unified row (one line per
 * row) and the split row (two independent lines sharing one row).
 * @param {SnapshotFile} file
 * @param {HTMLElement} row
 * @param {'old'|'new'} side
 * @param {number|null} lineNo
 * @returns {(event: MouseEvent) => void}
 */
const pickHandler = (file, row, side, lineNo) => (event) => {
  const line = Number(lineNo);
  if (!Number.isInteger(line) || line === 0) return;

  // The side must match too: the old and new gutters are adjacent columns, so
  // extending across them would build a quote for code the human never chose.
  // The hunk must match as well: crossing into another hunk starts a fresh
  // selection rather than silently splicing out the unchanged gap between them.
  const sameHunk = row.dataset.hunk === picking.hunk;
  const sameSelection = picking.start !== null && picking.file === file.path;
  const shiftExtend = event.shiftKey && sameSelection && side === picking.side && sameHunk;

  // A shift-click only counts as a rejection if there was a selection to
  // extend in the first place: a plain click, or the very first shift-click
  // with nothing picked yet, is not a rejection and must stay silent.
  const rejected = event.shiftKey && sameSelection && !shiftExtend;

  if (shiftExtend) {
    picking.end = line;
  } else {
    picking.file = file.path;
    picking.side = side;
    picking.start = line;
    picking.end = line;
    picking.hunk = row.dataset.hunk ?? null;
  }
  paintPick();

  const existingComposer = /** @type {HTMLElement|null} */ (document.querySelector('.thread.composer'));
  if (shiftExtend && existingComposer) {
    updateComposerHeader(existingComposer, file);
  } else {
    openComposer(file, row);
    if (rejected) {
      const warn = document.querySelector('.thread.composer .warn');
      if (warn) warn.textContent = HUNK_BOUNDARY_MSG;
    }
  }
};

/**
 * @param {SnapshotFile} file
 * @param {DiffLine} line0
 * @param {number} hunkIndex
 * @returns {HTMLElement}
 */
const renderRow = (file, line0, hunkIndex) => {
  const row = el('div', `row ${line0.kind}`);
  const oldNo = el('span', 'n', line0.oldLine === null ? '' : String(line0.oldLine));
  const newNo = el('span', 'n', line0.newLine === null ? '' : String(line0.newLine));
  const cell = el('span', 't');
  const rendered = renderLine(line0.text);
  cell.innerHTML = rendered.html;
  // The truncation mark is CSS-generated content, not a child node: this cell's
  // textContent is read back verbatim as the quote for a new comment, and a
  // literal "(line truncated)" suffix baked into a text node would corrupt it.
  if (rendered.truncated) cell.classList.add('truncated');
  row.append(oldNo, newNo, cell);

  row.dataset.file = file.path;
  row.dataset.newLine = String(line0.newLine ?? '');
  row.dataset.oldLine = String(line0.oldLine ?? '');
  row.dataset.hunk = String(hunkIndex);

  oldNo.addEventListener('click', pickHandler(file, row, 'old', line0.oldLine));
  newNo.addEventListener('click', pickHandler(file, row, 'new', line0.newLine));

  return row;
};

/**
 * @param {SnapshotFile} file
 * @param {import('./pair.js').Pair} pair
 * @param {number} hunkIndex
 * @returns {HTMLElement}
 */
const renderSplitRow = (file, pair, hunkIndex) => {
  const row = el('div', 'row split');
  row.dataset.file = file.path;
  row.dataset.hunk = String(hunkIndex);
  row.dataset.oldLine = String(pair.old?.oldLine ?? '');
  row.dataset.newLine = String(pair.new?.newLine ?? '');

  /**
   * @param {DiffLine|null} line
   * @param {'old'|'new'} side
   * @returns {[HTMLElement, HTMLElement]}
   */
  const cell = (line, side) => {
    const lineNo = line === null ? null : (side === 'old' ? line.oldLine : line.newLine);
    const no = el('span', 'n', lineNo === null ? '' : String(lineNo));
    const text = el('span', `t ${line === null ? 'blank' : line.kind}`);
    if (line !== null) {
      const rendered = renderLine(line.text);
      text.innerHTML = rendered.html;
      // CSS-generated content, not a child node — see renderRow for why.
      if (rendered.truncated) text.classList.add('truncated');
    }
    text.dataset.side = side;
    if (line !== null) no.addEventListener('click', pickHandler(file, row, side, lineNo));
    return [no, text];
  };

  row.append(...cell(pair.old, 'old'), ...cell(pair.new, 'new'));
  return row;
};

/** @returns {void} */
const renderDiff = () => {
  const session = /** @type {Session} */ (view.session);
  const pane = $('diff');
  pane.replaceChildren();
  pane.classList.toggle('split', session.view === 'split');

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

  const split = session.view === 'split';

  file.hunks.forEach((hunk, hunkIndex) => {
    const expand = el('button', 'expand', `⋯ ${hunk.header || `line ${hunk.newStart}`} ⋯`);
    expand.addEventListener('click', () => expandAbove(file, hunk, hunkIndex, pane, expand));
    pane.append(expand);

    if (split) {
      for (const pair of pairLines(hunk.lines)) pane.append(renderSplitRow(file, pair, hunkIndex));
    } else {
      for (const line of hunk.lines) pane.append(renderRow(file, line, hunkIndex));
    }
  });

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
 * @param {number} hunkIndex
 * @param {HTMLElement} pane
 * @param {HTMLElement} anchor
 * @returns {Promise<void>}
 */
const expandAbove = async (file, hunk, hunkIndex, pane, anchor) => {
  const from = Math.max(1, hunk.newStart - 8);
  const res = await api(`/context?file=${encodeURIComponent(file.path)}&from=${from}&to=${hunk.newStart - 1}`);
  if (!res.ok) return;

  const { lines, from: start } = await res.json();
  /** @type {DiffLine[]} */
  const expanded = lines.map((/** @type {string} */ text, /** @type {number} */ i) => (
    { kind: 'context', text, oldLine: null, newLine: start + i }
  ));

  // The working tree has no old-side line mapping for expanded context, so
  // split view shows it as new-only, same as the unified row's blank old gutter.
  const rows = view.session?.view === 'split'
    ? expanded.map((/** @type {DiffLine} */ line) => renderSplitRow(file, { old: null, new: line }, hunkIndex))
    : expanded.map((/** @type {DiffLine} */ line) => renderRow(file, line, hunkIndex));
  anchor.replaceWith(...rows);
};

/** @returns {Promise<void>} */
const send = async () => {
  const res = await api('/send', { method: 'POST', body: JSON.stringify({}) });
  if (res.ok) await load();
};

/** @type {EventSource|null} */
let stream = null;

/**
 * The terminal state, reached whether the human pressed Done or the agent ran
 * `cr close`. Closing the EventSource is what keeps the badge from flapping
 * back to connected: the browser retries a dropped stream by itself, and the
 * daemon now exits once the last session closes, so those retries would fail
 * forever against a port with nothing behind it.
 * @returns {void}
 */
const markClosed = () => {
  /** @type {HTMLButtonElement} */ ($('send')).disabled = true;
  /** @type {HTMLButtonElement} */ ($('done')).disabled = true;
  // Into the children, not #note itself: overwriting #note would delete #ident
  // and #say, and the next render would look up elements that no longer exist.
  $('ident').textContent = 'Session closed';
  $('say').textContent = 'You can close this tab.';

  stream?.close();
  const badge = $('stream');
  badge.textContent = 'disconnected';
  badge.dataset.state = 'down';
};

/** @returns {Promise<void>} */
const done = async () => {
  // Closing is irreversible: a closed session's comments and replies are not kept.
  if (!window.confirm("End this review? The session's comments and replies will not be kept.")) return;

  const res = await api('/close', { method: 'POST', body: JSON.stringify({ closedBy: 'human' }) });
  await load();

  // Never claim the session closed unless the server agreed.
  if (!res.ok) return;

  markClosed();
};

/** Set once the overlay is actually on screen, so its hide can be timed against it. @type {number|null} */
let overlayShownAt = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let overlayHideTimer = null;

/**
 * Runs `work` behind the diff overlay, but only reveals it if `work` outlasts
 * `showDelayMs`, so an instant local update never flashes it, and keeps it up
 * for `minVisibleMs` once shown so a fast one never flickers it away. With
 * `showDelayMs: 0` the overlay is change feedback rather than a slow-work
 * spinner: `overlayVisible` is already true at elapsed 0, so it reveals on
 * the same tick instead of waiting on a timer, which would otherwise race a
 * fast `work` finishing before the timer callback ran. The `finally`
 * guarantees the overlay clears even if `work` rejects, so a failed fetch
 * can never leave the pane blocked.
 * @param {() => Promise<void>} work
 * @param {{showDelayMs?: number, minVisibleMs?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
const withOverlay = async (work, options = {}) => {
  const { showDelayMs = OVERLAY_SHOW_DELAY_MS, minVisibleMs = OVERLAY_MIN_VISIBLE_MS, label = 'Updating' } = options;
  const overlay = $('diff-overlay');
  $('diff-overlay-label').textContent = label;
  if (overlayHideTimer !== null) clearTimeout(overlayHideTimer);

  let finished = false;
  const reveal = () => {
    overlay.classList.add('visible');
    overlayShownAt = Date.now();
  };

  let showTimer = null;
  if (overlayVisible({ elapsedMs: 0, finished, showDelayMs })) {
    reveal();
  } else {
    showTimer = setTimeout(() => {
      if (overlayVisible({ elapsedMs: showDelayMs, finished })) reveal();
    }, showDelayMs);
  }

  try {
    await work();
  } finally {
    finished = true;
    if (showTimer !== null) clearTimeout(showTimer);
    if (overlayShownAt !== null) {
      const shownAt = overlayShownAt;
      overlayHideTimer = setTimeout(() => {
        overlay.classList.remove('visible');
        overlayShownAt = null;
      }, remainingVisibleMs(Date.now() - shownAt, minVisibleMs));
    }
  }
};

/** @returns {void} */
const subscribe = () => {
  const badge = $('stream');
  const source = new EventSource(`/api/sessions/${key}/stream?t=${encodeURIComponent(token)}`);
  stream = source;

  source.addEventListener('open', () => { badge.textContent = 'connected'; badge.dataset.state = 'up'; });
  source.addEventListener('error', () => { badge.textContent = 'disconnected'; badge.dataset.state = 'down'; });
  // `refreshed` is the moment the agent's fix lands and the whole snapshot is
  // replaced: that is change feedback, not slow-work covering, so it must
  // always be seen rather than only when the reload happens to be slow. The
  // rest (a new comment, a status change, a note or view toggle) redraw the
  // same diff and would just train the human to ignore a loader that flashes
  // for nothing.
  source.addEventListener('refreshed', () => { void withOverlay(load, {
    showDelayMs: OVERLAY_REFRESHED_SHOW_DELAY_MS,
    minVisibleMs: OVERLAY_REFRESHED_MIN_VISIBLE_MS,
    label: 'Refreshing',
  }); });
  for (const name of ['comment', 'sent', 'note', 'view']) {
    source.addEventListener(name, () => { void load(); });
  }

  // Kept out of the list above: `cr close` has to reach the same terminal state
  // as the Done button, and load() on its own leaves the tab looking live.
  source.addEventListener('closed', () => { void load().then(markClosed); });
};

/** @returns {Promise<void>} */
const load = async () => {
  const res = await api('');
  if (!res.ok) {
    $('say').textContent = res.status === 401
      ? 'This link is missing its token. Reopen the session from the terminal.'
      : `Cannot load this session (${res.status}).`;
    return;
  }

  const session = await res.json();
  view.session = session;
  view.current ??= session.snapshot.files[0]?.path ?? null;
  // A short, stable label, kept apart from the message. --say rewrites the
  // note every round, so using it as the header made the title as long as
  // whatever the agent last said.
  const ident = session.pr
    ? `PR #${session.pr} → ${session.base}`
    : session.branch
      ? `${session.branch}${session.base ? ` → ${session.base}` : ''}`
      : session.base
        ? `→ ${session.base}`
        : 'working tree';
  const said = session.note || '';
  $('ident').textContent = ident;
  $('say').textContent = said;
  $('note').title = said ? `${ident}: ${said}` : ident;
  // The label names what clicking will switch to, read from the session so two
  // tabs cannot disagree, never from local state.
  $('view').textContent = session.view === 'split' ? 'unified' : 'split';
  renderFiles();
  renderDiff();
  counts();
  renderActivity();
  renderQueuePanel();
};

/** @returns {Promise<void>} */
const toggleView = async () => {
  const next = view.session?.view === 'split' ? 'unified' : 'split';
  await api('/view', { method: 'PATCH', body: JSON.stringify({ view: next }) });
  await load();
};

$('send').addEventListener('click', send);
$('done').addEventListener('click', done);
$('view').addEventListener('click', toggleView);
$('queue-open').addEventListener('click', () => toggleQueuePanel('queued'));
$('answered-open').addEventListener('click', () => toggleQueuePanel('answered'));
$('resolved-open').addEventListener('click', () => toggleQueuePanel('resolved'));
$('queue-close').addEventListener('click', closeQueuePanel);
$('queue-send').addEventListener('click', async () => { await send(); closeQueuePanel(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // The panel takes priority: closing it must not also discard an unrelated
  // in-progress composer, which clearPick() would do.
  if (panelGroup !== null) { closeQueuePanel(); return; }
  clearPick();
});

subscribe();
await withOverlay(load);
