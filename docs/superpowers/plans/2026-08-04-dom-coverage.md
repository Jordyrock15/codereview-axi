# DOM Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put `src/server/public/app.js` under test, by moving its decisions into pure modules and driving the remaining DOM code under jsdom.

**Architecture:** Layer 1 extracts four new pure modules plus one added function, and rewires `app.js` to call them. `app.js` keeps every DOM read and write. Layer 2 adds `test/helpers/dom.js`, which builds the real shell HTML from `src/server/ui.js`, installs stubbed globals, and imports `app.js` with a cache-busting query so each test gets fresh module state. Layer 3 adds four jsdom suites, one per area of the UI.

**Tech Stack:** Node 22, `node --test`, `node:assert/strict`, JSDoc types checked by `tsc --noEmit`, jsdom 29 as a dev dependency, the newest line that still supports node 20. No runtime dependencies.

**Source spec:** `docs/superpowers/specs/2026-08-04-dom-coverage-design.md`

## Global Constraints

- Never run `git commit` without explicit permission from the user in the current turn. Each commit step below is a request for permission, not authority to commit.
- Never add AI attribution to a commit message.
- Package manager is npm. The repo has `package-lock.json`.
- No runtime dependencies. `jsdom` goes in `devDependencies` only.
- `npm run check` must pass. It runs `tsc --noEmit` then `node --test`. `checkJs` and `strict` are on, and `include` covers `bin`, `src` and `test`, so test files and helpers need JSDoc types.
- Every interface and typedef needs a JSDoc block with an `@interface` tag and `@property` tags. Use an em dash before each property description. This is the only place an em dash is allowed.
- Use arrow functions. Never the `function` keyword.
- Write no comments unless a reader who knows the language would get the code wrong without one. Move an existing rationale comment into the new module rather than deleting it.
- Prose style is British English, Simplified Technical English, no em dashes outside JSDoc `@property` lines.
- Layer 1 must not change behaviour. Every string the UI renders stays byte for byte the same.
- Commit types: `refactor:` for each extraction task, `test:` for the harness and the jsdom suites.
- Extraction and jsdom tests must not share a commit. The extraction is the only part that can break real behaviour, so it stays revertable on its own.
- The current suite has 618 tests passing. No task may reduce that count.

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `src/server/public/labels.js` | Header text: the ident ladder, the view toggle label, the note tooltip |
| `src/server/public/counts.js` | Counter numbers, the Send buttons' label, disabled state and title |
| `src/server/public/quote.js` | The quote text and the contiguity judgement for a picked range |
| `src/server/public/pick.js` | The gutter-click selection rules, the range maths, the draft key |
| `test/helpers/dom.js` | `mountApp`, the fake network, the fake `EventSource`, session fixtures |
| `test/server/labels.test.js` | Tests for `labels.js` |
| `test/server/counts.test.js` | Tests for `counts.js` |
| `test/server/quote.test.js` | Tests for `quote.js` |
| `test/server/pick.test.js` | Tests for `pick.js` |
| `test/server/app-render.test.js` | jsdom: files nav, rows, threads, header, guards |
| `test/server/app-composer.test.js` | jsdom: picking, composer, drafts, follow-ups |
| `test/server/app-panels.test.js` | jsdom: the three group panels |
| `test/server/app-lifecycle.test.js` | jsdom: send, done, stream events, overlay, expand |

**Modified:**

| Path | Change |
| --- | --- |
| `src/server/public/activity.js` | Add `activityLabel(state)` |
| `test/server/activity.test.js` | Add the six wording tests |
| `src/server/public/app.js` | Call the new modules. Keep every DOM read and write |
| `package.json` | Add `jsdom` to `devDependencies` |

---

### Task 1: labels.js

**Files:**
- Create: `src/server/public/labels.js`
- Create: `test/server/labels.test.js`
- Modify: `src/server/public/app.js:1063-1097` (the `load` function)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `identLabel(session) => string`, `viewToggleLabel(session) => string`, `noteTitle(ident, said) => string`.

- [ ] **Step 1: Write the failing test**

Create `test/server/labels.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identLabel, viewToggleLabel, noteTitle } from '../../src/server/public/labels.js';

test('a PR session names the PR and its base', () => {
  assert.equal(identLabel({ pr: 41, base: 'main', branch: 'feat/x' }), 'PR #41 → main');
});

test('a branch session names the branch and its base', () => {
  assert.equal(identLabel({ pr: null, base: 'main', branch: 'feat/x' }), 'feat/x → main');
});

test('a branch with no base names the branch alone', () => {
  assert.equal(identLabel({ pr: null, base: null, branch: 'feat/x' }), 'feat/x');
});

test('a base with no branch names the base alone', () => {
  assert.equal(identLabel({ pr: null, base: 'main', branch: null }), '→ main');
});

test('no PR, branch or base is the working tree', () => {
  assert.equal(identLabel({ pr: null, base: null, branch: null }), 'working tree');
});

test('an undefined branch, written by an older version, still reads', () => {
  assert.equal(identLabel({ pr: null, base: 'main', branch: undefined }), '→ main');
});

test('the view toggle names the view a click switches to', () => {
  assert.equal(viewToggleLabel({ view: 'split' }), 'unified');
  assert.equal(viewToggleLabel({ view: 'unified' }), 'split');
});

test('a note goes in the tooltip after the ident', () => {
  assert.equal(noteTitle('feat/x → main', 'fixed the ack'), 'feat/x → main: fixed the ack');
});

test('no note leaves the tooltip as the ident alone', () => {
  assert.equal(noteTitle('feat/x → main', ''), 'feat/x → main');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server/labels.test.js`
Expected: FAIL, `Cannot find module .../src/server/public/labels.js`.

- [ ] **Step 3: Write the module**

Create `src/server/public/labels.js`:

```js
/**
 * @typedef {import('../../types.js').Session} Session
 */

/**
 * A short, stable label for the tab, kept apart from the note. `--say`
 * rewrites the note every round, so using it as the header made the title as
 * long as whatever the agent last said.
 * @param {Pick<Session, 'pr'|'base'|'branch'>} session
 * @returns {string}
 */
export const identLabel = (session) => {
  if (session.pr) return `PR #${session.pr} → ${session.base}`;
  if (session.branch) return `${session.branch}${session.base ? ` → ${session.base}` : ''}`;
  if (session.base) return `→ ${session.base}`;
  return 'working tree';
};

/**
 * Names what a click switches to, read from the session so two tabs cannot
 * disagree, never from local state.
 * @param {Pick<Session, 'view'>} session
 * @returns {string}
 */
export const viewToggleLabel = (session) => (session.view === 'split' ? 'unified' : 'split');

/**
 * @param {string} ident
 * @param {string} said
 * @returns {string}
 */
export const noteTitle = (ident, said) => (said ? `${ident}: ${said}` : ident);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/labels.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Rewire app.js**

In `src/server/public/app.js`, add to the import block after line 17:

```js
import { identLabel, viewToggleLabel, noteTitle } from './labels.js';
```

Replace the ident ladder inside `load` (currently lines 1075 to 1091) with:

```js
  const ident = identLabel(session);
  const said = session.note || '';
  $('ident').textContent = ident;
  $('say').textContent = said;
  $('note').title = noteTitle(ident, said);
  $('view').textContent = viewToggleLabel(session);
```

Delete the two comment blocks that moved into `labels.js` JSDoc. Keep the rest of `load` unchanged.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS. Test count is 618 plus 9.

- [ ] **Step 7: Commit (ask the user first)**

```bash
git add src/server/public/labels.js src/server/public/app.js test/server/labels.test.js
git commit -m "refactor: move the header labels out of the DOM code"
```

---

### Task 2: counts.js

**Files:**
- Create: `src/server/public/counts.js`
- Create: `test/server/counts.test.js`
- Modify: `src/server/public/app.js:124-156` (the `counts` function)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `countsView(comments) => CountsView`, where `CountsView` is `{unsent: number, answered: number, stale: number, resolved: number, staleLabel: string, sendLabel: string, sendDisabled: boolean, sendTitle: string}`.

- [ ] **Step 1: Write the failing test**

Create `test/server/counts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countsView } from '../../src/server/public/counts.js';

/**
 * @typedef {import('../../src/types.js').Comment} Comment
 */

/**
 * @param {Partial<Comment>} overrides
 * @returns {Comment}
 */
const comment = (overrides = {}) => ({
  id: 1, scope: 'line', file: 'a.js', side: 'new', startLine: 1, endLine: 1,
  quote: '', body: '', verdict: 'fix', status: 'open', replies: [],
  deliveredAt: null, createdAt: '', updatedAt: '', ...overrides,
});

test('each status is counted on its own', () => {
  const shown = countsView([
    comment({ id: 1, status: 'open' }),
    comment({ id: 2, status: 'open' }),
    comment({ id: 3, status: 'answered' }),
    comment({ id: 4, status: 'stale' }),
    comment({ id: 5, status: 'resolved' }),
  ]);
  assert.equal(shown.unsent, 2);
  assert.equal(shown.answered, 1);
  assert.equal(shown.stale, 1);
  assert.equal(shown.resolved, 1);
});

test('no stale comment leaves the stale label empty', () => {
  assert.equal(countsView([comment({ status: 'open' })]).staleLabel, '');
});

test('a stale comment is reported as text', () => {
  assert.equal(countsView([comment({ status: 'stale' })]).staleLabel, '1 stale');
});

test('an empty queue disables Send and drops the number', () => {
  const shown = countsView([comment({ status: 'answered' })]);
  assert.equal(shown.sendLabel, 'Send');
  assert.equal(shown.sendDisabled, true);
  assert.equal(shown.sendTitle, '');
});

test('a queued comment enables Send and counts it', () => {
  const shown = countsView([comment({ status: 'open' })]);
  assert.equal(shown.sendLabel, 'Send 1');
  assert.equal(shown.sendDisabled, false);
});

test('one reply owed blocks Send in the singular', () => {
  const shown = countsView([comment({ id: 1, status: 'open' }), comment({ id: 2, status: 'sent' })]);
  assert.equal(shown.sendDisabled, true);
  assert.equal(shown.sendLabel, 'Send 1');
  assert.equal(shown.sendTitle, 'The agent still owes a reply. Your drafts stay queued until it has answered.');
});

test('two replies owed block Send in the plural', () => {
  const shown = countsView([
    comment({ id: 1, status: 'open' }),
    comment({ id: 2, status: 'sent' }),
    comment({ id: 3, status: 'sent' }),
  ]);
  assert.equal(shown.sendTitle, 'The agent still owes 2 replies. Your drafts stay queued until it has answered.');
});

test('no comments at all is a disabled, unlabelled Send', () => {
  const shown = countsView([]);
  assert.deepEqual(shown, {
    unsent: 0, answered: 0, stale: 0, resolved: 0,
    staleLabel: '', sendLabel: 'Send', sendDisabled: true, sendTitle: '',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server/counts.test.js`
Expected: FAIL, `Cannot find module .../src/server/public/counts.js`.

- [ ] **Step 3: Write the module**

Create `src/server/public/counts.js`:

```js
/**
 * @typedef {import('../../types.js').Comment} Comment
 */

/**
 * Everything the header's counters and the two Send buttons render.
 * @interface CountsView
 * @typedef {Object} CountsView
 * @property {number} unsent — Comments still `open`, the number Send offers to send.
 * @property {number} answered — Comments the agent has replied to.
 * @property {number} stale — Comments whose anchor no longer matches the diff.
 * @property {number} resolved — Threads the human has closed.
 * @property {string} staleLabel — The stale count as text, empty when nothing is stale.
 * @property {string} sendLabel — The text both Send buttons carry.
 * @property {boolean} sendDisabled — Whether both Send buttons are disabled.
 * @property {string} sendTitle — Why Send is blocked, empty when it is not.
 */

/**
 * One round at a time. A batch sent while the agent still owes replies on the
 * last one arrives mid-edit and gets answered against code that has already
 * moved, and it was how sixteen comments ended up in flight at once with no
 * way to tell which round they belonged to. Queue as much as you like; the
 * send waits.
 * @param {Comment[]} comments
 * @returns {CountsView}
 */
export const countsView = (comments) => {
  /**
   * @param {Comment['status']} status
   * @returns {number}
   */
  const count = (status) => comments.filter((c) => c.status === status).length;

  const unsent = count('open');
  const stale = count('stale');
  const awaitingAgent = count('sent');
  const blocked = awaitingAgent > 0;

  return {
    unsent,
    answered: count('answered'),
    stale,
    resolved: count('resolved'),
    staleLabel: stale === 0 ? '' : `${stale} stale`,
    sendLabel: unsent === 0 ? 'Send' : `Send ${unsent}`,
    sendDisabled: unsent === 0 || blocked,
    sendTitle: blocked
      ? `The agent still owes ${awaitingAgent === 1 ? 'a reply' : `${awaitingAgent} replies`}. Your drafts stay queued until it has answered.`
      : '',
  };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/counts.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Rewire app.js**

Add to the import block:

```js
import { countsView } from './counts.js';
```

Replace the whole `counts` function body (lines 124 to 156) with:

```js
/** @returns {void} */
const counts = () => {
  const shown = countsView(view.session?.comments ?? []);

  // unsent and answered are the Queued and Answered buttons' own numbers, so
  // only stale is left to report as text, and only when there is any.
  $('counts-unsent').textContent = shown.staleLabel;
  $('counts-rest').textContent = '';
  $('queue-open').textContent = `Queued ${shown.unsent}`;
  $('answered-open').textContent = `Answered ${shown.answered}`;
  $('resolved-open').textContent = `Resolved ${shown.resolved}`;

  for (const id of ['send', 'queue-send']) {
    const button = /** @type {HTMLButtonElement} */ ($(id));
    button.disabled = shown.sendDisabled;
    button.textContent = shown.sendLabel;
    button.title = shown.sendTitle;
  }
};
```

The one-round comment moved into `counts.js`, so it must not stay here.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit (ask the user first)**

```bash
git add src/server/public/counts.js src/server/public/app.js test/server/counts.test.js
git commit -m "refactor: move the counter and send rules out of the DOM code"
```

---

### Task 3: quote.js

**Files:**
- Create: `src/server/public/quote.js`
- Create: `test/server/quote.test.js`
- Modify: `src/server/public/app.js:440-454` (`quoteFromRows`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildQuote(rows, from, to) => {quote: string, contiguous: boolean, rowCount: number}`, where each row is `{line: number, hunk: string, text: string}`.

- [ ] **Step 1: Write the failing test**

Create `test/server/quote.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuote } from '../../src/server/public/quote.js';

/**
 * @param {number} line
 * @param {string} text
 * @param {string} [hunk]
 * @returns {{line: number, hunk: string, text: string}}
 */
const row = (line, text, hunk = '0') => ({ line, hunk, text });

test('one line in range is the whole quote', () => {
  const result = buildQuote([row(1, 'a'), row(2, 'b'), row(3, 'c')], 2, 2);
  assert.deepEqual(result, { quote: 'b', contiguous: true, rowCount: 1 });
});

test('several lines join with newlines, in row order', () => {
  const result = buildQuote([row(1, 'a'), row(2, 'b'), row(3, 'c')], 1, 3);
  assert.equal(result.quote, 'a\nb\nc');
  assert.equal(result.rowCount, 3);
});

test('a row with no number on this side is skipped without breaking contiguity', () => {
  const result = buildQuote([row(1, 'a'), row(0, 'deleted'), row(2, 'b')], 1, 2);
  assert.equal(result.quote, 'a\nb');
  assert.equal(result.contiguous, true);
});

test('a range reaching into another hunk is not contiguous', () => {
  const result = buildQuote([row(1, 'a', '0'), row(9, 'b', '1')], 1, 9);
  assert.equal(result.contiguous, false);
  assert.equal(result.rowCount, 2);
});

test('no matching row gives a row count of zero and no contiguity', () => {
  const result = buildQuote([row(1, 'a')], 5, 6);
  assert.deepEqual(result, { quote: '', contiguous: false, rowCount: 0 });
});

test('a blank line is a legitimate one-line quote', () => {
  const result = buildQuote([row(1, 'a'), row(2, ''), row(3, 'c')], 2, 2);
  assert.deepEqual(result, { quote: '', contiguous: true, rowCount: 1 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server/quote.test.js`
Expected: FAIL, `Cannot find module .../src/server/public/quote.js`.

- [ ] **Step 3: Write the module**

Create `src/server/public/quote.js`:

```js
/**
 * One diff row, as the quote builder needs it.
 * @interface QuoteRow
 * @typedef {Object} QuoteRow
 * @property {number} line — Line number on the side being quoted, 0 when that side has no number on this row.
 * @property {string} hunk — Which hunk the row belongs to, used to judge contiguity.
 * @property {string} text — The text the human saw on this row.
 */

/**
 * @interface QuoteResult
 * @typedef {Object} QuoteResult
 * @property {string} quote — The chosen rows' text, joined by newlines.
 * @property {boolean} contiguous — Whether every chosen row belongs to one hunk.
 * @property {number} rowCount — How many rows the range matched.
 */

/**
 * The rows are what the human saw and chose. Building the quote from them,
 * rather than from file.hunks, is what makes expanded context and hunk edges
 * correct.
 *
 * Contiguity is judged by hunk membership, not by adjacency within the row
 * list: a deleted line has no new-side number and so is skipped when building
 * a new-side quote, but that skip does not break contiguity, the deleted text
 * is genuinely absent from the new file. What does break it is a range that
 * reaches into a different hunk, since the lines omitted between two hunks
 * are real, unselected lines the quote would otherwise silently drop.
 * @param {QuoteRow[]} rows
 * @param {number} from
 * @param {number} to
 * @returns {QuoteResult}
 */
export const buildQuote = (rows, from, to) => {
  const chosen = rows.filter((r) => Number.isInteger(r.line) && r.line >= from && r.line <= to);
  const contiguous = chosen.length > 0 && chosen.every((r) => r.hunk === chosen[0].hunk);
  return { quote: chosen.map((r) => r.text).join('\n'), contiguous, rowCount: chosen.length };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/quote.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Rewire app.js**

Add to the import block:

```js
import { buildQuote } from './quote.js';
```

Replace `quoteFromRows` (lines 440 to 454, keeping the `@param` and `@returns` block above it, and moving its long rationale into `quote.js`) with:

```js
/**
 * Reads the picked rows out of the DOM and hands them to `buildQuote`.
 * @param {'old'|'new'} side
 * @param {number} from
 * @param {number} to
 * @returns {import('./quote.js').QuoteResult}
 */
const quoteFromRows = (side, from, to) => {
  const key = side === 'new' ? 'newLine' : 'oldLine';
  const rows = selectionRows($('diff')).map((row) => ({
    line: Number(row.dataset[key] || 0),
    hunk: row.dataset.hunk ?? '',
    text: textOf(row, side),
  }));
  return buildQuote(rows, from, to);
};
```

This reads the text of every row rather than only the chosen ones. It runs once per save click, so the cost does not matter.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit (ask the user first)**

```bash
git add src/server/public/quote.js src/server/public/app.js test/server/quote.test.js
git commit -m "refactor: move the quote contiguity rule out of the DOM code"
```

---

### Task 4: pick.js

**Files:**
- Create: `src/server/public/pick.js`
- Create: `test/server/pick.test.js`
- Modify: `src/server/public/app.js:84` (`draftKey`), `:103-121` (`paintPick`), `:461-467` (`openComposer`), `:565-567` (`updateComposerHeader`), `:732-770` (`pickHandler`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `nextPick(pick, click) => {pick: Pick, shiftExtend: boolean, rejected: boolean}`, `pickRange(pick) => {from: number, to: number}`, `inPickRange(line, side, pick) => boolean`, `draftKey(pick) => string`. `Pick` is `{file: string|null, side: 'old'|'new', start: number|null, end: number|null, hunk: string|null}`. `PickClick` is `{file: string, side: 'old'|'new', line: number, hunk: string|null, shiftKey: boolean}`.

- [ ] **Step 1: Write the failing test**

Create `test/server/pick.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPick, pickRange, inPickRange, draftKey } from '../../src/server/public/pick.js';

/**
 * @typedef {import('../../src/server/public/pick.js').Pick} Pick
 */

/** @type {Pick} */
const NOTHING = { file: null, side: 'new', start: null, end: null, hunk: null };

/**
 * @param {Partial<Pick>} overrides
 * @returns {Pick}
 */
const picked = (overrides = {}) => ({ file: 'a.js', side: 'new', start: 4, end: 4, hunk: '0', ...overrides });

/**
 * @param {Partial<import('../../src/server/public/pick.js').PickClick>} overrides
 * @returns {import('../../src/server/public/pick.js').PickClick}
 */
const click = (overrides = {}) => ({ file: 'a.js', side: 'new', line: 6, hunk: '0', shiftKey: false, ...overrides });

test('a plain click starts a one-line range', () => {
  const result = nextPick(NOTHING, click());
  assert.deepEqual(result.pick, { file: 'a.js', side: 'new', start: 6, end: 6, hunk: '0' });
  assert.equal(result.shiftExtend, false);
  assert.equal(result.rejected, false);
});

test('a plain click on an existing selection restarts it', () => {
  const result = nextPick(picked(), click({ line: 9 }));
  assert.deepEqual(result.pick, { file: 'a.js', side: 'new', start: 9, end: 9, hunk: '0' });
  assert.equal(result.rejected, false);
});

test('shift extends the end inside one hunk and side', () => {
  const result = nextPick(picked(), click({ line: 6, shiftKey: true }));
  assert.deepEqual(result.pick, { file: 'a.js', side: 'new', start: 4, end: 6, hunk: '0' });
  assert.equal(result.shiftExtend, true);
  assert.equal(result.rejected, false);
});

test('shift into another hunk restarts and reports a rejection', () => {
  const result = nextPick(picked(), click({ line: 20, hunk: '1', shiftKey: true }));
  assert.deepEqual(result.pick, { file: 'a.js', side: 'new', start: 20, end: 20, hunk: '1' });
  assert.equal(result.shiftExtend, false);
  assert.equal(result.rejected, true);
});

test('shift on the other side restarts and reports a rejection', () => {
  const result = nextPick(picked(), click({ side: 'old', shiftKey: true }));
  assert.equal(result.pick.side, 'old');
  assert.equal(result.rejected, true);
});

test('shift in another file restarts and stays silent', () => {
  const result = nextPick(picked(), click({ file: 'b.js', shiftKey: true }));
  assert.equal(result.pick.file, 'b.js');
  assert.equal(result.rejected, false);
});

test('a first shift-click with nothing picked stays silent', () => {
  const result = nextPick(NOTHING, click({ shiftKey: true }));
  assert.equal(result.shiftExtend, false);
  assert.equal(result.rejected, false);
});

test('a range whose end precedes its start reads low to high', () => {
  assert.deepEqual(pickRange(picked({ start: 9, end: 4 })), { from: 4, to: 9 });
});

test('a range with no end is the start line alone', () => {
  assert.deepEqual(pickRange(picked({ start: 7, end: null })), { from: 7, to: 7 });
});

test('a line inside the range on the picked side is in range', () => {
  assert.equal(inPickRange(5, 'new', picked({ start: 4, end: 6 })), true);
});

test('a line outside the range is not in range', () => {
  assert.equal(inPickRange(9, 'new', picked({ start: 4, end: 6 })), false);
});

test('the same line on the other side is not in range', () => {
  assert.equal(inPickRange(5, 'old', picked({ start: 4, end: 6 })), false);
});

test('nothing is in range when nothing is picked', () => {
  assert.equal(inPickRange(5, 'new', NOTHING), false);
});

test('the draft key ignores the end line, so a shift-extend keeps one draft', () => {
  assert.equal(draftKey(picked({ start: 4, end: 4 })), draftKey(picked({ start: 4, end: 9 })));
});

test('a different file, side or start line gets its own draft key', () => {
  const base = draftKey(picked());
  assert.notEqual(base, draftKey(picked({ file: 'b.js' })));
  assert.notEqual(base, draftKey(picked({ side: 'old' })));
  assert.notEqual(base, draftKey(picked({ start: 5 })));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server/pick.test.js`
Expected: FAIL, `Cannot find module .../src/server/public/pick.js`.

- [ ] **Step 3: Write the module**

Create `src/server/public/pick.js`:

```js
/**
 * The human's in-progress line selection.
 * @interface Pick
 * @typedef {Object} Pick
 * @property {string|null} file — Path the selection sits in, null when nothing is picked.
 * @property {'old'|'new'} side — Which gutter the selection was made in.
 * @property {number|null} start — First picked line, null when nothing is picked.
 * @property {number|null} end — Last picked line, null when nothing is picked.
 * @property {string|null} hunk — Hunk the selection belongs to, null when nothing is picked.
 */

/**
 * One gutter click, as the selection rules need it.
 * @interface PickClick
 * @typedef {Object} PickClick
 * @property {string} file — Path of the file the row belongs to.
 * @property {'old'|'new'} side — Which gutter took the click.
 * @property {number} line — Line number under the click.
 * @property {string|null} hunk — Hunk the clicked row belongs to.
 * @property {boolean} shiftKey — Whether shift was held.
 */

/**
 * @interface PickOutcome
 * @typedef {Object} PickOutcome
 * @property {Pick} pick — The selection after the click.
 * @property {boolean} shiftExtend — True when the click extended the range instead of starting a new one.
 * @property {boolean} rejected — True when a shift-click could not extend, so the caller must say why.
 */

/**
 * The side must match: the old and new gutters are adjacent columns, so
 * extending across them would build a quote for code the human never chose.
 * The hunk must match as well: crossing into another hunk starts a fresh
 * selection rather than silently splicing out the unchanged gap between them.
 *
 * A shift-click only counts as a rejection if there was a selection to extend
 * in the first place: a plain click, or the very first shift-click with
 * nothing picked yet, is not a rejection and must stay silent.
 * @param {Pick} pick
 * @param {PickClick} click
 * @returns {PickOutcome}
 */
export const nextPick = (pick, click) => {
  const sameSelection = pick.start !== null && pick.file === click.file;
  const shiftExtend = click.shiftKey && sameSelection && click.side === pick.side && click.hunk === pick.hunk;

  if (shiftExtend) {
    return { pick: { ...pick, end: click.line }, shiftExtend: true, rejected: false };
  }

  return {
    pick: { file: click.file, side: click.side, start: click.line, end: click.line, hunk: click.hunk },
    shiftExtend: false,
    rejected: click.shiftKey && sameSelection,
  };
};

/**
 * @param {Pick} pick
 * @returns {{from: number, to: number}}
 */
export const pickRange = (pick) => {
  const start = pick.start ?? 0;
  const end = pick.end ?? start;
  return { from: Math.min(start, end), to: Math.max(start, end) };
};

/**
 * @param {number} line
 * @param {'old'|'new'} side
 * @param {Pick} pick
 * @returns {boolean}
 */
export const inPickRange = (line, side, pick) => {
  if (pick.start === null || side !== pick.side) return false;
  const { from, to } = pickRange(pick);
  return line >= from && line <= to;
};

/**
 * In-progress composer text survives a re-render only if it is kept outside
 * the DOM the render wipes. Keyed by file, side and the range's start line,
 * not the end: a shift-extend changes the end without rebuilding the
 * composer, so keying on the end too would silently fork a single in-progress
 * draft into two map entries, the older of which `clearPick` would never
 * reach. A different pick (different file, side or start line) still gets its
 * own entry and never inherits someone else's draft.
 * @param {Pick} pick
 * @returns {string}
 */
export const draftKey = (pick) => `${pick.file}::${pick.side}::${pick.start}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/pick.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Rewire app.js**

Add to the import block:

```js
import { nextPick, pickRange, inPickRange, draftKey } from './pick.js';
```

Replace the `picking` declaration and the `drafts` block (lines 68 to 84) with:

```js
/** @type {import('./pick.js').Pick} */
const picking = { file: null, side: 'new', start: null, end: null, hunk: null };

/** @type {Map<string, {text: string, selStart: number, selEnd: number}>} */
const drafts = new Map();
```

The long draft-key rationale moved into `pick.js`, so it must not stay here.

Replace every bare `draftKey()` call with `draftKey(picking)`. There are three: in `clearPick`, and twice in `openComposer`.

Replace the range loop inside `paintPick` (lines 107 to 120) with:

```js
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.row'))) {
    if (row.dataset.file !== picking.file) continue;

    const line = Number(row.dataset[picking.side === 'new' ? 'newLine' : 'oldLine'] || 0);
    if (!inPickRange(line, picking.side, picking)) continue;

    if (row.classList.contains('split')) {
      row.querySelector(`.t[data-side="${picking.side}"]`)?.classList.add('picked');
    } else {
      row.classList.add('picked');
    }
  }
```

In `openComposer`, replace the two lines that compute `from` and `to` (lines 466 to 467) with:

```js
  const { from, to } = pickRange(picking);
```

In `updateComposerHeader`, replace the same two lines (566 to 567) with:

```js
  const { from, to } = pickRange(picking);
```

In the save handler inside `openComposer`, replace the `start` and `end` lines (508 to 509) with:

```js
    // Read live: a shift-extend since the composer opened only moves the
    // range's end, it does not rebuild this handler's closure.
    const { from: start, to: end } = pickRange(picking);
```

Replace the rule block inside `pickHandler` (lines 732 to 758, up to and including `paintPick();`) with:

```js
const pickHandler = (file, row, side, lineNo) => (event) => {
  const line = Number(lineNo);
  if (!Number.isInteger(line) || line === 0) return;

  const outcome = nextPick(picking, {
    file: file.path, side, line, hunk: row.dataset.hunk ?? null, shiftKey: event.shiftKey,
  });
  Object.assign(picking, outcome.pick);
  paintPick();
```

Then replace the two later uses of the old local names with the outcome's fields:

```js
  const existingComposer = /** @type {HTMLElement|null} */ (document.querySelector('.thread.composer'));
  if (outcome.shiftExtend && existingComposer) {
    updateComposerHeader(existingComposer, file);
  } else {
    openComposer(file, row);
    if (outcome.rejected) {
      const warn = document.querySelector('.thread.composer .warn');
      if (warn) warn.textContent = HUNK_BOUNDARY_MSG;
    }
  }
};
```

`Object.assign` matters: `picking` is read live by handler closures, so the object's identity must survive.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Verify the behaviour in a real browser**

Run: `node bin/cr.js` in a repo with uncommitted changes, then open the printed URL.
Check by hand: a plain gutter click opens the composer; shift-click extends the highlight; shift-click into another hunk shows "Selection crosses a hunk boundary."; typed text survives a shift-extend.

This is the one task where a regression would be invisible to the suite, because the jsdom tests do not exist yet.

- [ ] **Step 8: Commit (ask the user first)**

```bash
git add src/server/public/pick.js src/server/public/app.js test/server/pick.test.js
git commit -m "refactor: move the gutter selection rules out of the DOM code"
```

---

### Task 5: activityLabel

**Files:**
- Modify: `src/server/public/activity.js` (append the new function)
- Modify: `test/server/activity.test.js` (append the wording tests)
- Modify: `src/server/public/app.js:363-379` (`renderActivity`)

**Interfaces:**
- Consumes: `activityState(session, now) => ActivityState` from the existing module.
- Produces: `activityLabel(state) => string`.

- [ ] **Step 1: Write the failing test**

Append to `test/server/activity.test.js`:

```js
test('waiting with a lease is the agent listening', () => {
  assert.equal(activityLabel({ delivery: 'waiting', polling: true }), 'agent listening');
});

test('waiting with no lease is waiting for the agent', () => {
  assert.equal(activityLabel({ delivery: 'waiting', polling: false }), 'waiting for agent');
});

test('working with a lease is the agent working', () => {
  assert.equal(activityLabel({ delivery: 'working', polling: true }), 'agent working');
});

test('working with no lease is the agent having it', () => {
  assert.equal(activityLabel({ delivery: 'working', polling: false }), 'agent has it');
});

test('idle with a lease is the agent connected', () => {
  assert.equal(activityLabel({ delivery: 'idle', polling: true }), 'agent connected');
});

test('idle with no lease has nothing to say', () => {
  assert.equal(activityLabel({ delivery: 'idle', polling: false }), '');
});
```

Change the import at the top of the same file to:

```js
import { activityState, activityLabel } from '../../src/server/public/activity.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server/activity.test.js`
Expected: FAIL, `activityLabel is not a function`.

- [ ] **Step 3: Write the function**

Append to `src/server/public/activity.js`:

```js
/**
 * `delivery` and `polling` are independent, not ranked: a lease can be held
 * during any delivery state, most usefully during `waiting`, so this maps the
 * pair to one label rather than picking a single "most urgent" state.
 * @param {ActivityState} state
 * @returns {string}
 */
export const activityLabel = (state) => {
  if (state.delivery === 'waiting') return state.polling ? 'agent listening' : 'waiting for agent';
  if (state.delivery === 'working') return state.polling ? 'agent working' : 'agent has it';
  return state.polling ? 'agent connected' : '';
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/activity.test.js`
Expected: PASS, the existing tests plus 6.

- [ ] **Step 5: Rewire app.js**

Change the activity import to:

```js
import { activityState, activityLabel } from './activity.js';
```

Replace `renderActivity` (lines 357 to 379, including the comment block that moved into `activity.js`) with:

```js
/** @returns {void} */
const renderActivity = () => {
  const node = $('activity');
  if (!view.session) { node.replaceChildren(); return; }

  const state = activityState(view.session);
  node.dataset.delivery = state.delivery;
  node.dataset.polling = String(state.polling);

  const label = activityLabel(state);
  node.replaceChildren();
  if (label) node.append(el('span', 'dot'), el('span', 'label', label));
};
```

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit (ask the user first)**

```bash
git add src/server/public/activity.js src/server/public/app.js test/server/activity.test.js
git commit -m "refactor: move the activity wording next to its state"
```

---

### Task 6: the jsdom harness

**Files:**
- Modify: `package.json` (add the dev dependency)
- Create: `test/helpers/dom.js`
- Create: `test/server/app-render.test.js` (one smoke test only, filled out in Task 7)

**Interfaces:**
- Consumes: `shellHtml(key)` from `src/server/ui.js`, and the extracted modules through `app.js`.
- Produces: `mountApp(options) => Promise<Mounted>` where `Mounted` is `{window, document, requests, session, emit, confirmNext, setSession, teardown}`, plus `sessionFixture(overrides) => Session`, `fileFixture(overrides) => SnapshotFile`, `commentFixture(overrides) => Comment`, `hunkFixture(overrides) => Hunk`.

- [ ] **Step 1: Add the dev dependency**

Run: `npm install --save-dev jsdom@^29`
Expected: `package.json` gains `"jsdom": "^29.1.1"` under `devDependencies`, and `package-lock.json` updates.

- [ ] **Step 2: Write the harness**

Create `test/helpers/dom.js`:

```js
import { JSDOM } from 'jsdom';
import { shellHtml } from '../../src/server/ui.js';

/**
 * @typedef {import('../../src/types.js').Session} Session
 * @typedef {import('../../src/types.js').SnapshotFile} SnapshotFile
 * @typedef {import('../../src/types.js').Comment} Comment
 * @typedef {import('../../src/types.js').Hunk} Hunk
 * @typedef {import('../../src/types.js').DiffLine} DiffLine
 */

/**
 * One fake response, shaped like the parts of `Response` that app.js reads.
 * @interface FakeResponse
 * @typedef {Object} FakeResponse
 * @property {boolean} ok — Whether the status is below 400.
 * @property {number} status — HTTP status.
 * @property {() => Promise<any>} json — The body.
 */

/**
 * One recorded request.
 * @interface RecordedRequest
 * @typedef {Object} RecordedRequest
 * @property {string} method — HTTP method.
 * @property {string} path — Path after `/api/sessions/<key>`, query string included.
 * @property {any} body — Parsed request body, null when there was none.
 */

/**
 * A mounted app, with the handles a test drives it through.
 * @interface Mounted
 * @typedef {Object} Mounted
 * @property {import('jsdom').DOMWindow} window — The jsdom window.
 * @property {Document} document — Its document.
 * @property {RecordedRequest[]} requests — Every request app.js has made, in order.
 * @property {() => Session} session — The fixture as the fake server now holds it.
 * @property {(name: string) => Promise<void>} emit — Fires a stream event and waits for the reload it triggers.
 * @property {(answer: boolean) => void} confirmNext — What the next `window.confirm` returns.
 * @property {(next: Session) => void} setSession — Replaces the served session.
 * @property {() => void} teardown — Clears timers, restores globals and closes the window.
 */

let mounts = 0;

/**
 * @param {Partial<DiffLine>} overrides
 * @returns {DiffLine}
 */
export const lineFixture = (overrides = {}) => ({
  kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1, ...overrides,
});

/**
 * @param {Partial<Hunk>} overrides
 * @returns {Hunk}
 */
export const hunkFixture = (overrides = {}) => ({
  oldStart: 10,
  oldLines: 3,
  newStart: 10,
  newLines: 3,
  header: 'const api = () => {',
  lines: [
    lineFixture({ kind: 'context', text: 'const a = 1;', oldLine: 10, newLine: 10 }),
    lineFixture({ kind: 'del', text: 'const b = 2;', oldLine: 11, newLine: null }),
    lineFixture({ kind: 'add', text: 'const b = 3;', oldLine: null, newLine: 11 }),
  ],
  ...overrides,
});

/**
 * @param {Partial<SnapshotFile>} overrides
 * @returns {SnapshotFile}
 */
export const fileFixture = (overrides = {}) => ({
  path: 'src/a.js',
  oldPath: null,
  status: 'modified',
  binary: false,
  added: 1,
  removed: 1,
  hunks: [hunkFixture()],
  tags: [],
  ...overrides,
});

/**
 * @param {Partial<Comment>} overrides
 * @returns {Comment}
 */
export const commentFixture = (overrides = {}) => ({
  id: 1,
  scope: 'line',
  file: 'src/a.js',
  side: 'new',
  startLine: 11,
  endLine: 11,
  quote: 'const b = 3;',
  body: 'name this',
  verdict: 'fix',
  status: 'open',
  replies: [],
  deliveredAt: null,
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  ...overrides,
});

/**
 * @param {Partial<Session>} overrides
 * @returns {Session}
 */
export const sessionFixture = (overrides = {}) => ({
  key: 'abc123',
  token: 'tok',
  repo: '/tmp/repo',
  base: 'main',
  pr: null,
  branch: 'feat/x',
  url: 'http://127.0.0.1:4390/s/abc123?t=tok',
  status: 'open',
  closedBy: null,
  note: 'two comments answered',
  snapshot: { files: [fileFixture()], totals: { files: 1, added: 1, removed: 1 } },
  snapshotAt: '2026-08-04T10:00:00.000Z',
  comments: [],
  chat: [],
  lease: null,
  view: 'unified',
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  ...overrides,
});

/**
 * Mounts app.js against a jsdom page built from the real shell HTML, with the
 * network faked. Resolves once app.js's first render is done: app.js ends in a
 * top-level await, so the import settles after `load()` has run.
 * @param {{session?: Session, key?: string, token?: string, routes?: Record<string, (body: any) => {status: number, json?: any}>}} [options]
 * @returns {Promise<Mounted>}
 */
export const mountApp = async (options = {}) => {
  const key = options.key ?? 'abc123';
  const token = options.token ?? 'tok';
  const routes = options.routes ?? {};
  let served = options.session ?? sessionFixture({ key });

  const dom = new JSDOM(shellHtml(key), { url: `http://127.0.0.1:4390/s/${key}?t=${token}` });
  const { window } = dom;

  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {Record<string, ((event: any) => void)[]>} */
  const streamHandlers = {};
  /** @type {boolean} */
  let confirmAnswer = true;
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();

  /**
   * @param {string} path
   * @param {any} body
   * @returns {{status: number, json?: any}}
   */
  const route = (path, body) => {
    const [bare] = path.split('?');
    const comments = served.comments;

    if (bare === '') return { status: 200, json: served };

    if (bare === '/comments' ) {
      const id = comments.reduce((top, c) => Math.max(top, c.id), 0) + 1;
      served = { ...served, comments: [...comments, commentFixture({ ...body, id, status: 'open' })] };
      return { status: 200, json: { id } };
    }

    if (bare === '/send') {
      served = { ...served, comments: comments.map((c) => (c.status === 'open' ? { ...c, status: 'sent' } : c)) };
      return { status: 200, json: { sent: 1 } };
    }

    if (bare === '/close') {
      served = { ...served, status: 'closed', closedBy: 'human' };
      return { status: 200, json: { closed: true } };
    }

    if (bare === '/view') {
      served = { ...served, view: body.view };
      return { status: 200, json: { view: body.view } };
    }

    if (bare === '/context') {
      const from = Number(new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('from'));
      return { status: 200, json: { from, lines: ['const above = 1;', 'const above2 = 2;'] } };
    }

    const followup = bare.match(/^\/comments\/(\d+)\/followup$/);
    if (followup) {
      const id = Number(followup[1]);
      served = { ...served, comments: comments.map((c) => (c.id === id
        ? { ...c, status: 'open', replies: [...c.replies, { role: 'human', body: body.body, status: null, at: '', deliveredAt: null }] }
        : c)) };
      return { status: 200, json: { id } };
    }

    const one = bare.match(/^\/comments\/(\d+)$/);
    if (one) {
      const id = Number(one[1]);
      served = body === null
        ? { ...served, comments: comments.filter((c) => c.id !== id) }
        : { ...served, comments: comments.map((c) => (c.id === id ? { ...c, ...body } : c)) };
      return { status: 200, json: { id } };
    }

    return { status: 404, json: { error: `no fake route for ${bare}` } };
  };

  /**
   * @param {string} url
   * @param {{method?: string, body?: string}} [init]
   * @returns {Promise<FakeResponse>}
   */
  const fakeFetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(`/api/sessions/${key}`, '');
    const body = init.body === undefined ? null : JSON.parse(init.body);
    requests.push({ method, path, body });

    const override = routes[`${method} ${path.split('?')[0]}`];
    const result = override ? override(body) : route(path, method === 'DELETE' ? null : body);
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.json,
    };
  };

  class FakeEventSource {
    /** @param {string} url */
    constructor(url) {
      requests.push({ method: 'STREAM', path: url, body: null });
    }

    /**
     * @param {string} name
     * @param {(event: any) => void} handler
     * @returns {void}
     */
    addEventListener(name, handler) {
      streamHandlers[name] = [...(streamHandlers[name] ?? []), handler];
    }

    /** @returns {void} */
    close() {
      streamHandlers.closedByApp = [];
    }
  }

  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    setTimeout: globalThis.setTimeout,
  };

  window.Element.prototype.scrollIntoView = () => {};
  window.confirm = () => confirmAnswer;
  window.matchMedia = (/** @type {string} */ query) => /** @type {MediaQueryList} */ ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    addListener: () => {}, removeListener: () => {},
  });

  Object.assign(globalThis, {
    document: window.document,
    window,
    location: window.location,
    fetch: fakeFetch,
    EventSource: FakeEventSource,
  });

  // Recorded so teardown can clear them: the overlay's hide timer outlives a
  // test and would otherwise keep the event loop alive after the window closed.
  globalThis.setTimeout = /** @type {typeof setTimeout} */ (/** @type {unknown} */ (
    (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      const id = saved.setTimeout(fn, ms);
      timers.add(id);
      return id;
    }
  ));

  mounts += 1;
  const module = new URL('../../src/server/public/app.js', import.meta.url);
  await import(`${module.href}?n=${mounts}`);

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  const emit = async (name) => {
    for (const handler of streamHandlers[name] ?? []) handler({ type: name });
    await new Promise((resolve) => saved.setTimeout(resolve, 0));
  };

  return {
    window,
    document: window.document,
    requests,
    session: () => served,
    emit,
    confirmNext: (/** @type {boolean} */ answer) => { confirmAnswer = answer; },
    setSession: (/** @type {Session} */ next) => { served = next; },
    teardown: () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      Object.assign(globalThis, saved);
      window.close();
    },
  };
};
```

- [ ] **Step 3: Write the smoke test**

Create `test/server/app-render.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApp, sessionFixture } from '../helpers/dom.js';

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
```

- [ ] **Step 4: Run the smoke test**

Run: `node --test test/server/app-render.test.js`
Expected: PASS, 1 test. If it fails with `document is not defined`, the globals are being installed after the import; the `Object.assign(globalThis, ...)` must run before `await import`.

- [ ] **Step 5: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS. `tsc` must report no error inside `test/helpers/dom.js`.

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add package.json package-lock.json test/helpers/dom.js test/server/app-render.test.js
git commit -m "test: add a jsdom harness for the review UI"
```

---

### Task 7: app-render.test.js

**Files:**
- Modify: `test/server/app-render.test.js` (add every case beside the smoke test)

**Interfaces:**
- Consumes: `mountApp`, `sessionFixture`, `fileFixture`, `hunkFixture`, `commentFixture`, `lineFixture` from `test/helpers/dom.js`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Replace the import line in `test/server/app-render.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountApp, sessionFixture, fileFixture, hunkFixture, commentFixture, lineFixture,
} from '../helpers/dom.js';
```

Append:

```js
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
      comments: [commentFixture({ scope: 'session', file: null, side: null, startLine: null, endLine: null, status: 'answered' })],
    }),
  });
  try {
    const notes = app.document.querySelectorAll('#diff .thread.session-scope');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].hasAttribute('data-side'), false);
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
    assert.equal(app.document.getElementById('activity')?.textContent, '');
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
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/server/app-render.test.js`
Expected: PASS, 19 tests. Two failures are likely and are test bugs, not app bugs: the diffstat assertion depends on the two `span` children rendering without a separator, and the large-file threshold comes from `LARGE_FILE_LINES` in `src/diff/snapshot.js`. Read that constant and adjust the 900s if the guard does not trip.

- [ ] **Step 3: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit (ask the user first)**

```bash
git add test/server/app-render.test.js
git commit -m "test: cover the review UI's rendering paths"
```

---

### Task 8: app-composer.test.js

**Files:**
- Create: `test/server/app-composer.test.js`

**Interfaces:**
- Consumes: `mountApp`, `sessionFixture`, `fileFixture`, `hunkFixture`, `commentFixture`, `lineFixture` from `test/helpers/dom.js`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Create `test/server/app-composer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApp, sessionFixture, fileFixture, hunkFixture, commentFixture, lineFixture } from '../helpers/dom.js';

/**
 * A hunk with four plain context lines, so a range can span several rows
 * without a deletion or an addition complicating the line numbers.
 * @returns {import('../../src/types.js').Session}
 */
const plainSession = () => sessionFixture({
  snapshot: {
    files: [fileFixture({
      hunks: [hunkFixture({
        lines: [10, 11, 12, 13].map((n) => lineFixture({ text: `line ${n};`, oldLine: n, newLine: n })),
      })],
    })],
    totals: { files: 1, added: 0, removed: 0 },
  },
});

/**
 * @param {import('../helpers/dom.js').Mounted} app
 * @param {number} line
 * @param {{shiftKey?: boolean, side?: 'old'|'new'}} [options]
 * @returns {void}
 */
const clickGutter = (app, line, options = {}) => {
  const side = options.side === 'old' ? 'old' : 'new';
  const row = /** @type {HTMLElement} */ (app.document.querySelector(`#diff .row[data-${side}-line="${line}"]`));
  const gutter = /** @type {HTMLElement} */ (row.querySelectorAll('.n')[side === 'old' ? 0 : 1]);
  gutter.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, shiftKey: options.shiftKey ?? false }));
};

test('a gutter click opens the composer with the line in its heading', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const composer = app.document.querySelector('#diff .thread.composer');
    assert.ok(composer);
    assert.equal(composer?.querySelector('.annotate-label')?.textContent, 'Annotate');
    assert.equal(composer?.querySelector('.base')?.textContent, 'a.js:11');
    assert.equal(composer?.querySelector('.dir')?.textContent, 'src/');
    assert.equal(/** @type {HTMLElement} */ (composer?.querySelector('.who')).title, 'src/a.js:11');
  } finally {
    app.teardown();
  }
});

test('the picked row is highlighted', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const picked = app.document.querySelectorAll('#diff .row.picked');
    assert.equal(picked.length, 1);
    assert.equal(picked[0].getAttribute('data-new-line'), '11');
  } finally {
    app.teardown();
  }
});

test('a shift-extend keeps the typed text and widens the heading', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const text = /** @type {HTMLTextAreaElement} */ (app.document.querySelector('#diff .thread.composer textarea'));
    text.value = 'half a thought';
    text.dispatchEvent(new app.window.Event('input'));

    clickGutter(app, 13, { shiftKey: true });

    const composer = app.document.querySelector('#diff .thread.composer');
    assert.equal(/** @type {HTMLTextAreaElement} */ (composer?.querySelector('textarea')).value, 'half a thought');
    assert.equal(composer?.querySelector('.base')?.textContent, 'a.js:11-13');
    assert.equal(app.document.querySelectorAll('#diff .row.picked').length, 3);
  } finally {
    app.teardown();
  }
});

test('a shift-click on the other side restarts and says why', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    clickGutter(app, 12, { shiftKey: true, side: 'old' });
    assert.equal(
      app.document.querySelector('#diff .thread.composer .warn')?.textContent,
      'Selection crosses a hunk boundary. Pick a single unbroken range and try again.',
    );
  } finally {
    app.teardown();
  }
});

test('a successful shift-extend clears an earlier restart note', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    clickGutter(app, 12, { shiftKey: true, side: 'old' });
    clickGutter(app, 13, { shiftKey: true, side: 'old' });
    assert.equal(app.document.querySelector('#diff .thread.composer .warn')?.textContent, '');
  } finally {
    app.teardown();
  }
});

test('the verdict buttons track which one is pressed', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const buttons = [...app.document.querySelectorAll('#diff .thread.composer .verdicts button')];
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);

    /** @type {HTMLElement} */ (buttons[1]).click();
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  } finally {
    app.teardown();
  }
});

test('Queue posts the range, the quote and the verdict', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    clickGutter(app, 12, { shiftKey: true });
    const composer = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread.composer'));
    const text = /** @type {HTMLTextAreaElement} */ (composer.querySelector('textarea'));
    text.value = 'name these';
    text.dispatchEvent(new app.window.Event('input'));
    /** @type {HTMLElement} */ (composer.querySelectorAll('.verdicts button')[1]).click();

    /** @type {HTMLElement} */ (composer.querySelector('.actions .primary')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const posted = app.requests.find((r) => r.method === 'POST' && r.path === '/comments');
    assert.deepEqual(posted?.body, {
      scope: 'line', file: 'src/a.js', side: 'new', startLine: 11, endLine: 12,
      quote: 'line 11;\nline 12;', body: 'name these', verdict: 'explain',
    });
    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
  } finally {
    app.teardown();
  }
});

test('empty text is refused without a request', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread.composer .actions .primary')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(app.requests.some((r) => r.path === '/comments'), false);
    assert.ok(app.document.querySelector('#diff .thread.composer'));
  } finally {
    app.teardown();
  }
});

test("a server error reaches the composer's warning line", async () => {
  const app = await mountApp({
    session: plainSession(),
    routes: { 'POST /comments': () => ({ status: 409, json: { error: 'A round is already in flight.' } }) },
  });
  try {
    clickGutter(app, 11);
    const composer = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread.composer'));
    const text = /** @type {HTMLTextAreaElement} */ (composer.querySelector('textarea'));
    text.value = 'name this';
    text.dispatchEvent(new app.window.Event('input'));
    /** @type {HTMLElement} */ (composer.querySelector('.actions .primary')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(composer.querySelector('.warn')?.textContent, 'A round is already in flight.');
    assert.equal(/** @type {HTMLButtonElement} */ (composer.querySelector('.actions .primary')).disabled, false);
  } finally {
    app.teardown();
  }
});

test('Cancel closes the composer and drops the highlight', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const buttons = [...app.document.querySelectorAll('#diff .thread.composer .actions button')];
    /** @type {HTMLElement} */ (buttons[0]).click();
    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
    assert.equal(app.document.querySelectorAll('#diff .row.picked').length, 0);
  } finally {
    app.teardown();
  }
});

test('Escape closes the composer', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
  } finally {
    app.teardown();
  }
});

test('a draft survives a re-render, and the composer comes back', async () => {
  const app = await mountApp({ session: plainSession() });
  try {
    clickGutter(app, 11);
    const text = /** @type {HTMLTextAreaElement} */ (app.document.querySelector('#diff .thread.composer textarea'));
    text.value = 'half a thought';
    text.dispatchEvent(new app.window.Event('input'));

    await app.emit('comment');

    const composer = app.document.querySelector('#diff .thread.composer');
    assert.ok(composer, 'the composer is rebuilt after the render wiped it');
    assert.equal(/** @type {HTMLTextAreaElement} */ (composer?.querySelector('textarea')).value, 'half a thought');
  } finally {
    app.teardown();
  }
});

test('Reply posts a follow-up rather than resending the body', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'answered' })] }),
  });
  try {
    const thread = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread[data-comment-id="1"]'));
    /** @type {HTMLElement} */ (thread.querySelectorAll('.actions button')[0]).click();

    const followup = /** @type {HTMLElement} */ (thread.querySelector('.thread.composer.followup'));
    const text = /** @type {HTMLTextAreaElement} */ (followup.querySelector('textarea'));
    text.value = 'still wrong';
    /** @type {HTMLElement} */ (followup.querySelector('.actions .primary')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const posted = app.requests.find((r) => r.path === '/comments/1/followup');
    assert.deepEqual(posted?.body, { body: 'still wrong' });
  } finally {
    app.teardown();
  }
});

test('a follow-up error stays on screen with the button live again', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'answered' })] }),
    routes: { 'POST /comments/1/followup': () => ({ status: 500, json: null }) },
  });
  try {
    const thread = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread[data-comment-id="1"]'));
    /** @type {HTMLElement} */ (thread.querySelectorAll('.actions button')[0]).click();
    const followup = /** @type {HTMLElement} */ (thread.querySelector('.thread.composer.followup'));
    /** @type {HTMLTextAreaElement} */ (followup.querySelector('textarea')).value = 'still wrong';
    /** @type {HTMLElement} */ (followup.querySelector('.actions .primary')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(followup.querySelector('.warn')?.textContent, 'Queue failed (500).');
  } finally {
    app.teardown();
  }
});

test('Resolve patches the thread closed', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ status: 'answered' })] }),
  });
  try {
    const thread = /** @type {HTMLElement} */ (app.document.querySelector('#diff .thread[data-comment-id="1"]'));
    /** @type {HTMLElement} */ (thread.querySelectorAll('.actions button')[1]).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const patched = app.requests.find((r) => r.method === 'PATCH' && r.path === '/comments/1');
    assert.deepEqual(patched?.body, { status: 'resolved' });
    assert.equal(app.session().comments[0].status, 'resolved');
  } finally {
    app.teardown();
  }
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/server/app-composer.test.js`
Expected: PASS, 16 tests. If `clickGutter` cannot find a gutter, check the row's child order in `renderRow`: the old number is the first `.n`, the new number the second.

- [ ] **Step 3: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit (ask the user first)**

```bash
git add test/server/app-composer.test.js
git commit -m "test: cover the composer, drafts and follow-ups"
```

---

### Task 9: app-panels.test.js

**Files:**
- Create: `test/server/app-panels.test.js`

**Interfaces:**
- Consumes: `mountApp`, `sessionFixture`, `commentFixture` from `test/helpers/dom.js`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Create `test/server/app-panels.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApp, sessionFixture, commentFixture } from '../helpers/dom.js';

/**
 * @returns {import('../../src/types.js').Session}
 */
const withEachStatus = () => sessionFixture({
  comments: [
    commentFixture({ id: 1, status: 'open', body: 'queued one' }),
    commentFixture({ id: 2, status: 'answered', body: 'answered one' }),
    commentFixture({ id: 3, status: 'resolved', body: 'resolved one' }),
  ],
});

/**
 * @param {Document} document
 * @param {string} id
 * @returns {void}
 */
const press = (document, id) => { /** @type {HTMLElement} */ (document.getElementById(id)).click(); };

test('the panel starts shut', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
    assert.equal(app.document.getElementById('queue-open')?.getAttribute('aria-expanded'), 'false');
  } finally {
    app.teardown();
  }
});

test('each group names itself in the title, the region and the close button', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'answered-open');
    const panel = /** @type {HTMLElement} */ (app.document.getElementById('queue-panel'));
    assert.equal(panel.hidden, false);
    assert.equal(app.document.getElementById('queue-title')?.textContent, 'Answered');
    assert.equal(panel.getAttribute('aria-label'), 'Answered comments');
    assert.equal(app.document.getElementById('queue-close')?.getAttribute('aria-label'), 'Close answered comments');
    assert.equal(app.document.getElementById('answered-open')?.getAttribute('aria-expanded'), 'true');
  } finally {
    app.teardown();
  }
});

test('each group lists only its own comments', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'resolved-open');
    const bodies = [...app.document.querySelectorAll('#queue-list .queue-entry-body')].map((n) => n.textContent);
    assert.deepEqual(bodies, ['resolved one']);
  } finally {
    app.teardown();
  }
});

test('an empty group says what would collect there', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [] }) });
  try {
    press(app.document, 'queue-open');
    assert.equal(
      app.document.querySelector('#queue-list .queue-empty')?.textContent,
      'Nothing queued. Draft a comment on the diff and it will show up here before you send it.',
    );
  } finally {
    app.teardown();
  }
});

test('an entry splits its path so the filename survives', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    const loc = app.document.querySelector('#queue-list .queue-entry-loc');
    assert.equal(loc?.querySelector('.dir')?.textContent, 'src/');
    assert.equal(loc?.querySelector('.base')?.textContent, 'a.js:11');
    assert.equal(/** @type {HTMLElement} */ (loc).title, 'src/a.js:11');
  } finally {
    app.teardown();
  }
});

test('only a queued entry can be withdrawn', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    assert.equal(app.document.querySelectorAll('#queue-list .queue-entry-remove').length, 1);

    press(app.document, 'answered-open');
    assert.equal(app.document.querySelectorAll('#queue-list .queue-entry-remove').length, 0);
  } finally {
    app.teardown();
  }
});

test('Remove deletes the comment and reloads', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    /** @type {HTMLElement} */ (app.document.querySelector('#queue-list .queue-entry-remove')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(app.requests.some((r) => r.method === 'DELETE' && r.path === '/comments/1'));
    assert.equal(app.session().comments.length, 2);
  } finally {
    app.teardown();
  }
});

test('Send belongs to the queue alone', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-send')).hidden, false);

    press(app.document, 'resolved-open');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-send')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('pressing the same toggle twice shuts the panel', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    press(app.document, 'queue-open');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('pressing another toggle switches group rather than shutting', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    press(app.document, 'answered-open');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, false);
    assert.equal(app.document.getElementById('queue-title')?.textContent, 'Answered');
    assert.equal(app.document.getElementById('queue-open')?.getAttribute('aria-expanded'), 'false');
  } finally {
    app.teardown();
  }
});

test('a click outside shuts the panel', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    app.document.getElementById('diff')?.dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('a click inside the panel leaves it open', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    app.document.getElementById('queue-list')?.dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, false);
  } finally {
    app.teardown();
  }
});

test('the close button shuts the panel', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    press(app.document, 'queue-close');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('Escape shuts the panel and leaves an open composer alone', async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    const row = /** @type {HTMLElement} */ (app.document.querySelector('#diff .row[data-new-line="10"]'));
    /** @type {HTMLElement} */ (row.querySelectorAll('.n')[1]).dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    press(app.document, 'queue-open');

    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
    assert.ok(app.document.querySelector('#diff .thread.composer'), 'the composer survives the first Escape');

    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(app.document.querySelector('#diff .thread.composer'), null);
  } finally {
    app.teardown();
  }
});

test("the panel's Send sends and then shuts the panel", async () => {
  const app = await mountApp({ session: withEachStatus() });
  try {
    press(app.document, 'queue-open');
    press(app.document, 'queue-send');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(app.requests.some((r) => r.method === 'POST' && r.path === '/send'));
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});

test('an entry click scrolls to its thread and shuts the panel', async () => {
  const app = await mountApp({
    session: sessionFixture({ comments: [commentFixture({ id: 1, status: 'answered' })] }),
  });
  try {
    press(app.document, 'answered-open');
    /** @type {HTMLElement} */ (app.document.querySelector('#queue-list .queue-entry-open')).click();
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-panel')).hidden, true);
  } finally {
    app.teardown();
  }
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/server/app-panels.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 3: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit (ask the user first)**

```bash
git add test/server/app-panels.test.js
git commit -m "test: cover the queued, answered and resolved panels"
```

---

### Task 10: app-lifecycle.test.js

**Files:**
- Create: `test/server/app-lifecycle.test.js`

**Interfaces:**
- Consumes: `mountApp`, `sessionFixture`, `commentFixture` from `test/helpers/dom.js`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Create `test/server/app-lifecycle.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApp, sessionFixture, commentFixture } from '../helpers/dom.js';

/**
 * @param {Document} document
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
const button = (document, id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));

test('an empty queue leaves Send disabled and unnumbered', async () => {
  const app = await mountApp();
  try {
    assert.equal(button(app.document, 'send').disabled, true);
    assert.equal(button(app.document, 'send').textContent, 'Send');
  } finally {
    app.teardown();
  }
});

test('a queued comment enables Send and counts it', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    assert.equal(button(app.document, 'send').disabled, false);
    assert.equal(button(app.document, 'send').textContent, 'Send 1');
    assert.equal(app.document.getElementById('queue-open')?.textContent, 'Queued 1');
  } finally {
    app.teardown();
  }
});

test('a round still owed blocks Send and says why', async () => {
  const app = await mountApp({
    session: sessionFixture({
      comments: [commentFixture({ id: 1, status: 'open' }), commentFixture({ id: 2, status: 'sent' })],
    }),
  });
  try {
    const send = button(app.document, 'send');
    assert.equal(send.disabled, true);
    assert.equal(send.title, 'The agent still owes a reply. Your drafts stay queued until it has answered.');
    assert.equal(button(app.document, 'queue-send').disabled, true);
  } finally {
    app.teardown();
  }
});

test('a stale comment is reported next to the counters', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'stale' })] }) });
  try {
    assert.equal(app.document.getElementById('counts-unsent')?.textContent, '1 stale');
    assert.equal(app.document.getElementById('counts-rest')?.textContent, '');
  } finally {
    app.teardown();
  }
});

test('Send posts the round and reloads', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    button(app.document, 'send').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(app.requests.some((r) => r.method === 'POST' && r.path === '/send'));
    assert.equal(app.session().comments[0].status, 'sent');
  } finally {
    app.teardown();
  }
});

test('the view toggle patches the session', async () => {
  const app = await mountApp();
  try {
    button(app.document, 'view').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const patched = app.requests.find((r) => r.method === 'PATCH' && r.path === '/view');
    assert.deepEqual(patched?.body, { view: 'split' });
    assert.equal(app.document.getElementById('view')?.textContent, 'unified');
  } finally {
    app.teardown();
  }
});

test('Done confirms, closes the session and locks the tab', async () => {
  const app = await mountApp();
  try {
    app.confirmNext(true);
    button(app.document, 'done').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const closed = app.requests.find((r) => r.method === 'POST' && r.path === '/close');
    assert.deepEqual(closed?.body, { closedBy: 'human' });
    assert.equal(button(app.document, 'send').disabled, true);
    assert.equal(button(app.document, 'done').disabled, true);
    assert.equal(app.document.getElementById('ident')?.textContent, 'Session closed');
    assert.equal(app.document.getElementById('say')?.textContent, 'You can close this tab.');
    assert.equal(app.document.getElementById('stream')?.textContent, 'disconnected');
    assert.equal(app.document.getElementById('stream')?.getAttribute('data-state'), 'down');
  } finally {
    app.teardown();
  }
});

test('a cancelled confirm changes nothing', async () => {
  const app = await mountApp();
  try {
    app.confirmNext(false);
    button(app.document, 'done').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(app.requests.some((r) => r.path === '/close'), false);
    assert.equal(button(app.document, 'done').disabled, false);
  } finally {
    app.teardown();
  }
});

test('a refused close never claims the session ended', async () => {
  const app = await mountApp({ routes: { 'POST /close': () => ({ status: 500, json: null }) } });
  try {
    app.confirmNext(true);
    button(app.document, 'done').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.notEqual(app.document.getElementById('ident')?.textContent, 'Session closed');
  } finally {
    app.teardown();
  }
});

test('the stream badge follows the connection', async () => {
  const app = await mountApp();
  try {
    await app.emit('open');
    assert.equal(app.document.getElementById('stream')?.textContent, 'connected');
    assert.equal(app.document.getElementById('stream')?.getAttribute('data-state'), 'up');

    await app.emit('error');
    assert.equal(app.document.getElementById('stream')?.textContent, 'disconnected');
    assert.equal(app.document.getElementById('stream')?.getAttribute('data-state'), 'down');
  } finally {
    app.teardown();
  }
});

test('a comment event reloads the session', async () => {
  const app = await mountApp();
  try {
    const before = app.requests.filter((r) => r.method === 'GET' && r.path === '').length;
    await app.emit('comment');
    const after = app.requests.filter((r) => r.method === 'GET' && r.path === '').length;
    assert.equal(after, before + 1);
  } finally {
    app.teardown();
  }
});

test('a refreshed event reveals the overlay while it reloads', async () => {
  const app = await mountApp();
  try {
    await app.emit('refreshed');
    const overlay = /** @type {HTMLElement} */ (app.document.getElementById('diff-overlay'));
    assert.ok(overlay.classList.contains('visible'));
    assert.equal(app.document.getElementById('diff-overlay-label')?.textContent, 'Refreshing');
  } finally {
    app.teardown();
  }
});

test('the overlay clears itself once its minimum time is up', async () => {
  const app = await mountApp();
  try {
    await app.emit('refreshed');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('diff-overlay')).classList.contains('visible'), false);
  } finally {
    app.teardown();
  }
});

test('a closed event reaches the same terminal state as Done', async () => {
  const app = await mountApp();
  try {
    await app.emit('closed');
    assert.equal(app.document.getElementById('ident')?.textContent, 'Session closed');
    assert.equal(button(app.document, 'done').disabled, true);
    assert.equal(app.document.getElementById('stream')?.getAttribute('data-state'), 'down');
  } finally {
    app.teardown();
  }
});

test('expand fetches the lines above a hunk and replaces its button', async () => {
  const app = await mountApp();
  try {
    /** @type {HTMLElement} */ (app.document.querySelector('#diff .expand')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const asked = app.requests.find((r) => r.path.startsWith('/context'));
    assert.ok(asked?.path.includes('from=2'));
    assert.ok(asked?.path.includes('to=9'));
    assert.equal(app.document.querySelectorAll('#diff .expand').length, 0);
    assert.equal(app.document.querySelectorAll('#diff .row').length, 5);
  } finally {
    app.teardown();
  }
});

test('a refused context fetch leaves the expand button in place', async () => {
  const app = await mountApp({ routes: { 'GET /context': () => ({ status: 500, json: null }) } });
  try {
    /** @type {HTMLElement} */ (app.document.querySelector('#diff .expand')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(app.document.querySelectorAll('#diff .expand').length, 1);
  } finally {
    app.teardown();
  }
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/server/app-lifecycle.test.js`
Expected: PASS, 16 tests. The overlay timing test waits 1200 ms against the real clock; read `OVERLAY_REFRESHED_MIN_VISIBLE_MS` in `src/server/public/overlay.js` and raise the wait if that constant is larger.

- [ ] **Step 3: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS. Total is 618 plus about 120 new tests.

- [ ] **Step 4: Confirm the UI still works in a browser**

Run: `node bin/cr.js`, then open the printed URL. Queue a comment, send it, toggle the view, open each panel, then press Done.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add test/server/app-lifecycle.test.js
git commit -m "test: cover sending, closing, stream events and expansion"
```

---

## Notes for the executor

- Run one task at a time. Every task ends green, so a failure belongs to the task in hand.
- If a jsdom test fails because jsdom lacks an API, add the stub to `test/helpers/dom.js` rather than changing `app.js`. `app.js` must keep working in a real browser.
- If a jsdom test fails because `app.js` is genuinely wrong, stop and report it. A found defect is a `fix:` commit of its own, which also gives release-please something to bump and finally exercises the publish pipeline.
- `styles.css` stays uncovered on purpose. Do not add a browser runner.
