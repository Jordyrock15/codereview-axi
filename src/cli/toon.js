const UNQUOTED_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const NUMERIC_LIKE = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i;
const NEEDS_QUOTE = /[:"\\[\]{},]|[\u0000-\u001f]/;

/**
 * @param {string} s
 * @returns {string}
 */
const escapeInner = (s) => s.replace(/[\\"\n\r\t\u0000-\u001f]/g, (/** @type {string} */ ch) => {
  if (ch === '\\') return '\\\\';
  if (ch === '"') return '\\"';
  if (ch === '\n') return '\\n';
  if (ch === '\r') return '\\r';
  if (ch === '\t') return '\\t';
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
});

/**
 * Quotes a string value only where section 7.2 requires it. An unquoted value
 * that should have been quoted decodes as the wrong type, so err towards quoting.
 * @param {string} s
 * @returns {string}
 */
export const quoteValue = (s) => {
  const must = s === ''
    || /^[ \t]/.test(s) || /[ \t]$/.test(s)
    || s === 'true' || s === 'false' || s === 'null'
    || NUMERIC_LIKE.test(s)
    || NEEDS_QUOTE.test(s)
    || s.startsWith('-') || s.startsWith('#');
  return must ? `"${escapeInner(s)}"` : s;
};

/**
 * @param {string} k
 * @returns {string}
 */
const key = (k) => (UNQUOTED_KEY.test(k) ? k : `"${escapeInner(k)}"`);

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isPrimitive = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * @param {unknown} v
 * @returns {string}
 */
const primitive = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`cannot encode the non-finite number ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return quoteValue(v);
  throw new Error(`cannot encode ${typeof v} as a primitive`);
};

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown[]} rows
 * @returns {string[]}
 */
const tabularFields = (rows) => {
  if (!rows.every(isPlainObject)) throw new Error('an array of objects must be uniform to encode');
  const fields = Object.keys(/** @type {Record<string, unknown>} */ (rows[0]));
  if (fields.length === 0) throw new Error('an array of objects must be uniform to encode');
  for (const row of rows) {
    const typedRow = /** @type {Record<string, unknown>} */ (row);
    const ks = Object.keys(typedRow);
    if (ks.length !== fields.length || !fields.every((f) => f in typedRow)) {
      throw new Error('an array of objects must be uniform to encode');
    }
    for (const f of fields) {
      if (!isPrimitive(typedRow[f])) throw new Error(`every tabular cell must be primitive, ${f} is not`);
    }
  }
  return fields;
};

/**
 * @param {string} k
 * @param {unknown[]} arr
 * @param {number} depth
 * @returns {string[]}
 */
const arrayLines = (k, arr, depth) => {
  const pad = '  '.repeat(depth);
  if (arr.length === 0) return [`${pad}${key(k)}: []`];
  if (arr.every(isPrimitive)) {
    return [`${pad}${key(k)}[${arr.length}]: ${arr.map(primitive).join(',')}`];
  }
  const fields = tabularFields(arr);
  const inner = '  '.repeat(depth + 1);
  return [
    `${pad}${key(k)}[${arr.length}]{${fields.map(key).join(',')}}:`,
    ...arr.map((row) => `${inner}${fields.map((f) => primitive(/** @type {any} */ (row)[f])).join(',')}`),
  ];
};

/**
 * @param {Record<string, unknown>} obj
 * @param {number} depth
 * @returns {string[]}
 */
const objectLines = (obj, depth) => {
  const pad = '  '.repeat(depth);
  /** @type {string[]} */
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) out.push(...arrayLines(k, v, depth));
    else if (isPlainObject(v)) out.push(`${pad}${key(k)}:`, ...objectLines(/** @type {any} */ (v), depth + 1));
    else out.push(`${pad}${key(k)}: ${primitive(v)}`);
  }
  return out;
};

/**
 * Encodes the shapes `cr` emits as TOON. Throws on anything outside that
 * subset: almost-TOON is worse than JSON, because it parses until it does not.
 * @param {unknown} value
 * @returns {string}
 */
export const encode = (value) => {
  if (!isPlainObject(value)) throw new Error('the root value must be an object');
  return objectLines(/** @type {any} */ (value), 0).join('\n');
};
