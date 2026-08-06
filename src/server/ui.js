import { readFile } from 'node:fs/promises';
import { LARGE_FILE_LINES } from '../diff/snapshot.js';

/** @type {Record<string, string>} */
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * The key comes straight from the URL, so it must be escaped regardless of
 * whether it happens to look like hex.
 * @param {string} text
 * @returns {string}
 */
const escapeHtml = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * @param {string} key
 * @returns {string}
 */
export const shellHtml = (key) => `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cr review</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body data-key="${escapeHtml(key)}" data-large="${LARGE_FILE_LINES}">
<header id="bar">
  <span id="note">
    <span id="ident"></span>
    <span id="say"></span>
  </span>
  <div id="bar-row">
    <span id="counts">
      <span id="counts-unsent">0 unsent</span>
      <span id="counts-rest">· 0 answered · 0 stale</span>
    </span>
    <span id="activity" data-delivery="idle"></span>
    <button id="view" title="Toggle side-by-side">split</button>
    <button id="queue-open" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="queue-panel">Queued 0</button>
    <button id="pending-open" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="queue-panel">Pending 0</button>
    <button id="answered-open" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="queue-panel">Answered 0</button>
    <button id="resolved-open" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="queue-panel">Resolved 0</button>
    <button id="send" disabled>Send</button>
    <button id="done">Done</button>
    <span id="stream" title="event stream">connecting</span>
  </div>
</header>
<div id="queue-panel" role="region" aria-label="Queued comments" hidden>
  <div class="queue-head">
    <span id="queue-title">Queue</span>
    <button id="queue-close" type="button" aria-label="Close queue">✕</button>
  </div>
  <div id="queue-list"></div>
  <div class="queue-foot">
    <button id="queue-send" type="button" disabled>Send</button>
  </div>
</div>
<main>
  <nav id="files" aria-label="Changed files"></nav>
  <div id="diff-wrap">
    <section id="diff" aria-label="Diff"></section>
    <div id="diff-overlay" aria-hidden="true"><span class="spinner"></span><span id="diff-overlay-label">Updating</span></div>
  </div>
</main>
<script type="module" src="/assets/app.js"></script>
</body>
</html>
`;

/**
 * @param {string} name
 * @returns {Promise<{status: number, type: string, body: string|null}>}
 */
export const assetResponse = async (name) => {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot);
  const type = TYPES[ext];

  if (!type || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { status: 404, type: 'text/plain; charset=utf-8', body: null };
  }

  try {
    const body = await readFile(new URL(`./public/${name}`, import.meta.url), 'utf8');
    return { status: 200, type, body };
  } catch {
    return { status: 404, type: 'text/plain; charset=utf-8', body: null };
  }
};
