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
  <span id="note"></span>
  <span id="counts"></span>
  <span id="activity" data-delivery="idle"></span>
  <button id="view" title="Toggle side-by-side">split</button>
  <button id="send" disabled>Send</button>
  <button id="done">Done</button>
  <span id="stream" title="event stream">connecting</span>
</header>
<main>
  <nav id="files" aria-label="Changed files"></nav>
  <section id="diff" aria-label="Diff"></section>
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
