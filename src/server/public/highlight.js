/** @type {Array<[string, RegExp]>} */
const PATTERNS = [
  ['comment', /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/],
  ['string', /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/],
  ['number', /\b(0x[\da-f]+|\d+(?:\.\d+)?)\b/i],
  ['keyword', /\b(const|let|var|function|return|if|else|for|while|await|async|import|export|from|class|new|throw|try|catch|finally|typeof|instanceof|null|undefined|true|false)\b/],
];

/** @type {Record<string, string>} */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * @param {string} text
 * @returns {string}
 */
const escape = (text) => text.replace(/[&<>]/g, (ch) => ESCAPES[ch]);

/**
 * Wraps recognised tokens in spans. Returns escaped HTML, safe for innerHTML:
 * both matched tokens and the plain text between them pass through escape().
 * @param {string} text
 * @returns {string}
 */
export const highlight = (text) => {
  const combined = new RegExp(PATTERNS.map(([, re]) => re.source).join('|'), 'gi');

  let out = '';
  let last = 0;

  for (const match of text.matchAll(combined)) {
    const index = match.index ?? 0;
    out += escape(text.slice(last, index));

    const groupIndex = match.slice(1).findIndex((group) => group !== undefined);
    const kind = PATTERNS[groupIndex]?.[0] ?? 'plain';
    out += `<span class="tok-${kind}">${escape(match[0])}</span>`;
    last = index + match[0].length;
  }

  return out + escape(text.slice(last));
};
