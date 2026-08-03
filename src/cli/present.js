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
  // Live session state on a bare `cr`: same next moves as any other verb
  // that just confirmed a session is open and comments may be pending.
  if (verb === 'help') return ['cr wait', 'cr list --status open'];
  return ['cr open'];
};

/** Prose for the error slugs an agent needs to act on rather than just branch on.
 * @type {Record<string, string>} */
const ERROR_NEXT_STEPS = {
  'nothing-to-review': 'There is nothing to review. Tell the human, and do not retry.',
  'agent-waiting': 'Another agent already holds the poll. This is retryable: wait a moment, then run `cr wait` again.',
  'session-closed': 'The session is closed. Do not reopen it.',
  'server-unreachable': 'Retry once. If it fails again, tell the human.',
  usage: 'Your own arguments were wrong. Read `cr <verb> --help`, then fix the command rather than retrying it unchanged.',
  'invalid-input': 'Your own arguments were wrong. Read `cr <verb> --help`, then fix the command rather than retrying it unchanged.',
};

const WAIT_CLOSED = 'The human pressed Done. Stop polling, do not reopen the session, and summarise what changed for the human.';

/**
 * The imperative instruction that keeps an agent in the loop without a human
 * having to prompt it again. Complements `help[]`: that is a command template,
 * this is the reason to run it. Deliberately omitted where the table gives no
 * specific advice, rather than emitting something vague.
 * @param {string} verb
 * @param {Record<string, any>} payload
 * @returns {string|undefined}
 */
export const nextStep = (verb, payload) => {
  const errorCode = payload && typeof payload === 'object' ? payload.error?.code : undefined;
  if (typeof errorCode === 'string') return ERROR_NEXT_STEPS[errorCode];

  // Only `wait` ever sets `closed`, but a session closing mid-poll matters
  // more than whatever else that response carries, so it is checked first.
  if (payload?.closed === true) return WAIT_CLOSED;

  if (verb === 'open') {
    return 'Do not reply to the human yet. Run `cr wait` now: it blocks silently until they press Send, which is normal, so do not kill it or add a short timeout.';
  }

  if (verb === 'wait') {
    if (Array.isArray(payload?.comments) && payload.comments.length > 0) {
      return 'Fix or answer each comment. Locate the code by its quote, not its line numbers, since comments re-anchor by quoted text and lines move as you edit. Reply to every comment with `cr reply`, then run `cr refresh` and `cr wait` again. Do not stop to report to the human.';
    }
    return 'Nothing has been sent yet. Run `cr wait` again. Do not report to the human, and do not treat this as the review being over.';
  }

  if (verb === 'list') {
    return 'Open comments here are drafts the human has not sent yet, so do not act on them. `cr wait` is what delivers work.';
  }

  if (verb === 'reply') {
    const stillSent = typeof payload?.counts?.sent === 'number' ? payload.counts.sent : 0;
    return stillSent > 0
      ? 'Reply to the remaining comments, then run `cr refresh` and `cr wait`.'
      : 'Run `cr refresh` so the human sees the fixes, then run `cr wait`.';
  }

  if (verb === 'refresh') return 'Run `cr wait`.';
  if (verb === 'close') return 'The session is over. Summarise what changed for the human.';

  // Live session state on a bare `cr`: same next move as any verb that just
  // confirmed a session is open and comments may be pending.
  if (verb === 'help') return 'A review is already open. Run `cr wait` to pick up whatever is waiting.';

  return undefined;
};

/**
 * @param {string|undefined} requested
 * @returns {string[]}
 */
export const selectFields = (requested) => {
  if (requested === undefined) return DEFAULT_COMMENT_FIELDS;
  if (requested === 'all') return AGENT_COMMENT_FIELDS;
  const asked = requested.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (asked.length === 0) {
    throw new Error(`--fields needs at least one field, available: ${AGENT_COMMENT_FIELDS.join(', ')}`);
  }
  const bad = asked.filter((f) => !AGENT_COMMENT_FIELDS.includes(f));
  if (bad.length > 0) {
    throw new Error(`unknown ${bad.length === 1 ? 'field' : 'fields'} ${bad.join(', ')}, available: ${AGENT_COMMENT_FIELDS.join(', ')}`);
  }
  return asked;
};
