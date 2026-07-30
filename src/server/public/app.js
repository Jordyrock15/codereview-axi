/**
 * @typedef {import('../../types.js').Session} Session
 * @typedef {import('../../types.js').SnapshotFile} SnapshotFile
 * @typedef {import('../../types.js').Hunk} Hunk
 * @typedef {import('../../types.js').DiffLine} DiffLine
 */

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

const LARGE = Number(document.body.dataset.large ?? 1500);

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
 * @param {SnapshotFile} file
 * @param {DiffLine} line
 * @returns {HTMLElement}
 */
const renderRow = (file, line) => {
  const row = el('div', `row ${line.kind}`);
  const oldNo = el('span', 'n', line.oldLine === null ? '' : String(line.oldLine));
  const newNo = el('span', 'n', line.newLine === null ? '' : String(line.newLine));
  row.append(oldNo, newNo, el('span', 't', line.text));

  // Task 20 attaches selection and commenting to these two cells.
  row.dataset.file = file.path;
  row.dataset.newLine = String(line.newLine ?? '');
  row.dataset.oldLine = String(line.oldLine ?? '');
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

  renderThreads(pane, file);
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

/**
 * Filled in by Task 20.
 * @param {HTMLElement} pane
 * @param {SnapshotFile} file
 * @returns {void}
 */
const renderThreads = (pane, file) => {};

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

await load();
