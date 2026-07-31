/**
 * The six fields an agent acts on. `quote` is included by ruling: it is what the
 * comment is anchored to, so it should never need asking for.
 */
export const DEFAULT_COMMENT_FIELDS = ['id', 'file', 'lines', 'verdict', 'body', 'quote'];

/**
 * Everything an agent may ask for. `deliveredAt` is deliberately absent: it is
 * at-most-once delivery bookkeeping, and there is nothing correct to do with it.
 */
export const AGENT_COMMENT_FIELDS = [
  'id', 'scope', 'file', 'lines', 'quote', 'body', 'verdict', 'status',
  'agentReply', 'createdAt', 'updatedAt',
];

/** The limit below is in characters (code points), not UTF-16 code units: an emoji is one character but two units. */
export const TRUNCATE_AT = 2000;

const TRUNCATED = new Set(['body', 'quote']);

/**
 * @param {string} value
 * @param {string} field
 * @param {number} [limit]
 * @returns {string}
 */
export const truncate = (value, field, limit = TRUNCATE_AT) => {
  const total = Array.from(value).length;
  if (!Number.isFinite(limit) || total <= limit) return value;
  const hint = ` (truncated, ${total} chars total, use --full to see complete ${field})`;
  let cut = Math.max(0, limit - hint.length);
  // A cut landing on a high surrogate would sever its low-surrogate partner,
  // which the TOON encoder refuses to emit; step back one code unit to keep the pair whole.
  if (cut > 0 && cut < value.length) {
    const code = value.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  return `${value.slice(0, cut)}${hint}`;
};

const lines = (/** @type {any} */ c) => {
  if (c.startLine === null || c.startLine === undefined) return '';
  const range = c.endLine !== null && c.endLine !== c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
  return c.side === null || c.side === undefined ? range : `${c.side}:${range}`;
};

const reply = (/** @type {any} */ c) => (
  c.agentReply === null || c.agentReply === undefined ? '' : `${c.agentReply.status}: ${c.agentReply.body}`
);

/**
 * @param {Record<string, unknown>} comment
 * @param {string[]} fields
 * @param {{limit?: number}} [options]
 * @returns {Record<string, string|number|boolean|null>}
 */
export const presentComment = (comment, fields, { limit = TRUNCATE_AT } = {}) => {
  /** @type {Record<string, string|number|boolean|null>} */
  const out = {};
  for (const f of fields) {
    if (f === 'lines') out.lines = lines(comment);
    else if (f === 'agentReply') out.agentReply = reply(comment);
    else {
      const v = comment[f];
      // Absent becomes empty rather than missing: the tabular form needs a
      // uniform key set across every row.
      if (v === undefined || v === null) out[f] = '';
      else out[f] = TRUNCATED.has(f) && typeof v === 'string' ? truncate(v, f, limit) : /** @type {any} */ (v);
    }
  }
  return out;
};

/**
 * Concrete next commands for the agent, with real ids filled in. Templates,
 * not prose: the caller pastes these, so anything unrunnable is worse than nothing.
 * @param {string} verb
 * @param {Record<string, any>} payload
 * @returns {string[]}
 */
export const nextSteps = (verb, payload) => {
  const first = Array.isArray(payload.comments) ? payload.comments[0] : undefined;
  // first.id is only there to quote back: if --fields dropped it, a reply
  // template naming "undefined" would be worse than no suggestion at all.
  if (first !== undefined && first.id !== undefined) {
    return [
      `cr reply --id ${first.id} --status fixed --body "..."`,
      'cr list --status open',
    ];
  }
  if (first !== undefined) return ['cr list --fields id,body,quote', 'cr list --status open'];
  if (payload.empty !== undefined) return ['cr list', 'cr wait'];
  if (verb === 'open' || verb === 'refresh') return ['cr wait'];
  if (verb === 'wait') return ['cr wait', 'cr close'];
  if (verb === 'reply') return ['cr wait'];
  return ['cr open'];
};

/**
 * @param {string|undefined} requested
 * @returns {string[]}
 */
export const selectFields = (requested) => {
  if (requested === undefined) return DEFAULT_COMMENT_FIELDS;
  if (requested === 'all') return AGENT_COMMENT_FIELDS;
  const asked = requested.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const bad = asked.filter((f) => !AGENT_COMMENT_FIELDS.includes(f));
  if (bad.length > 0) {
    throw new Error(`unknown ${bad.length === 1 ? 'field' : 'fields'} ${bad.join(', ')}, available: ${AGENT_COMMENT_FIELDS.join(', ')}`);
  }
  return asked;
};
