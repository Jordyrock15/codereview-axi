# Pending Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show how many comments the agent currently holds, as a fourth group beside Queued, Answered and Resolved.

**Architecture:** The group machinery already exists. `GROUPS` maps a group name to the statuses it collects, `groupEntries` turns any such filter into rows, and `PANELS` maps a group name to its labels. One shared panel serves every group. So this is data plus one button, not new behaviour.

**Tech Stack:** Node 20.19+, `node --test`, JSDoc types checked by `tsc --noEmit`, jsdom for the DOM suites.

**Source spec:** `docs/superpowers/specs/2026-08-05-pending-panel-design.md`

## Global Constraints

- Never run `git commit` or `git push` without explicit permission from the user in the current turn. Each commit step below is a request, not authority.
- Branch is `feat/pending-panel`, off main at 0.1.8. Do not create or switch branches.
- Arrow functions only, never the `function` keyword.
- No comments unless a reader who knows the language would get the code wrong without one, and then one line and one sentence.
- Every interface and typedef carries `@interface` and `@property` tags with an em dash before each description. That is the only place an em dash is allowed.
- Prose is British English and Simplified Technical English: active voice, simple tenses, no present perfect.
- `npm run check` runs `tsc --noEmit` then `node --test`, with `checkJs` and `strict` on. It must stay green.
- The suite is 737 tests before this work. It must not fall.
- Behaviour of the three existing groups must not change. Their labels, their empty copy, Remove on queued only, and the panel's Send on queued only all stay exactly as they are.
- Every jsdom test tears its mount down in a `finally`.

## File Structure

**Modified:**

| Path | Change |
| --- | --- |
| `src/server/public/counts.js` | `CountsView` gains `pending`, from the count already taken for the tooltip |
| `src/server/public/queue.js` | `GROUPS` gains `pending: ['sent']`, in lifecycle position |
| `src/server/public/app.js` | `PANELS` gains the pending entry, `counts()` writes its label, one listener wires the toggle |
| `src/server/ui.js` | the shell gains the button between Queued and Answered |
| `src/server/public/styles.css` | `#pending-open` joins the active-state selector |
| `test/server/counts.test.js` | pending assertions, and the whole-object `deepEqual` gains the field |
| `test/server/queue.test.js` | `groupEntries` over `['sent']` |
| `test/server/app-panels.test.js` | pending joins the group table, with no Remove and no panel Send |
| `test/server/app-lifecycle.test.js` | pressing Send moves Queued to 0 and Pending to 1 |

---

### Task 1: the number

**Files:**
- Modify: `src/server/public/counts.js`
- Modify: `test/server/counts.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `CountsView` gains `pending: number`, the count of comments whose status is `sent`. Task 2 renders it.

- [ ] **Step 1: Write the failing tests**

In `test/server/counts.test.js`, add:

```js
test('pending counts the comments the agent holds', () => {
  const shown = countsView([
    comment({ id: 1, status: 'open' }),
    comment({ id: 2, status: 'sent' }),
    comment({ id: 3, status: 'sent' }),
    comment({ id: 4, status: 'answered' }),
  ]);
  assert.equal(shown.pending, 2);
});

test('pending is zero when the agent holds nothing', () => {
  assert.equal(countsView([comment({ status: 'open' })]).pending, 0);
});

test('pending is the same number the blocked send names', () => {
  const shown = countsView([comment({ id: 1, status: 'open' }), comment({ id: 2, status: 'sent' })]);
  assert.equal(shown.pending, 1);
  assert.equal(shown.sendTitle, 'The agent still owes a reply. Your drafts stay queued until it has answered.');
});
```

Then update the existing whole-object assertion in the test named `no comments at all is a disabled, unlabelled Send`, so it reads:

```js
  assert.deepEqual(shown, {
    unsent: 0, answered: 0, stale: 0, resolved: 0, pending: 0,
    staleLabel: '', sendLabel: 'Send', sendDisabled: true, sendTitle: '',
  });
```

That `deepEqual` is the reason a new field cannot appear unnoticed. Update it rather than loosening it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server/counts.test.js`
Expected: the three new tests fail on `undefined`, and the `deepEqual` test fails on the missing key.

- [ ] **Step 3: Expose the count**

In `src/server/public/counts.js`, add to the `CountsView` JSDoc block, after the `resolved` property:

```js
 * @property {number} pending — Comments the agent holds and owes a reply on.
```

Then in the returned object, add `pending` beside the other numbers:

```js
  return {
    unsent,
    answered: count('answered'),
    stale,
    resolved: count('resolved'),
    pending: awaitingAgent,
    staleLabel: stale === 0 ? '' : `${stale} stale`,
```

`awaitingAgent` is the existing local, so the button's number and the blocked-send tooltip read one value. Do not add a second `count('sent')`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/server/counts.test.js`
Expected: PASS, the existing tests plus 3.

- [ ] **Step 5: Verify the whole suite**

Run: `npm run check`
Expected: PASS, 740 tests.

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add src/server/public/counts.js test/server/counts.test.js
git commit -m "feat(ui): count the comments the agent holds"
```

---

### Task 2: the panel and its button

**Files:**
- Modify: `src/server/public/queue.js`
- Modify: `src/server/public/app.js`
- Modify: `src/server/ui.js`
- Modify: `src/server/public/styles.css`
- Modify: `test/server/queue.test.js`
- Modify: `test/server/app-panels.test.js`
- Modify: `test/server/app-lifecycle.test.js`

**Interfaces:**
- Consumes: `CountsView.pending` from Task 1.
- Produces: a `pending` group in `GROUPS` and `PANELS`, and a `#pending-open` button in the shell.

- [ ] **Step 1: Write the failing tests**

In `test/server/queue.test.js`, add:

```js
test('a group of sent comments collects only what the agent holds', () => {
  const entries = groupEntries({
    comments: [
      comment({ id: 1, status: 'open', body: 'queued one' }),
      comment({ id: 2, status: 'sent', body: 'sent one' }),
      comment({ id: 3, status: 'sent', body: 'sent two' }),
      comment({ id: 4, status: 'answered', body: 'answered one' }),
    ],
  }, GROUPS.pending);
  assert.deepEqual(entries.map((e) => e.body), ['sent one', 'sent two']);
});
```

`GROUPS` is already imported in that file, so the import line needs no change.

In `test/server/app-panels.test.js`, add the pending row to `PANEL_CASES`, in lifecycle position, so the array reads queued, pending, answered, resolved:

```js
  {
    toggle: 'pending-open', title: 'Pending', region: 'Pending comments', close: 'Close pending comments',
    empty: 'Nothing pending. Comments you send wait here until the agent answers them.',
  },
```

The loop in the test named `each group names itself in the title, the region and the close button` currently visits `[PANEL_CASES[1], PANEL_CASES[2], PANEL_CASES[0]]`, so that queued comes last: its labels match the shell's static markup, and visiting it first would prove nothing. Replace that literal with a form that keeps the intent as the array grows:

```js
    for (const panelCase of [...PANEL_CASES.slice(1), PANEL_CASES[0]]) {
```

Make the same change in the test named `an empty group says what would collect there`.

Then add two tests to the same file:

```js
test('a pending comment cannot be withdrawn', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'sent' })] }) });
  try {
    press(app.document, 'pending-open');
    assert.equal(app.document.querySelectorAll('#queue-list .queue-entry').length, 1);
    assert.equal(app.document.querySelectorAll('#queue-list .queue-entry-remove').length, 0);
  } finally {
    app.teardown();
  }
});

test('the panel offers no Send from the pending group', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'sent' })] }) });
  try {
    press(app.document, 'pending-open');
    assert.equal(/** @type {HTMLElement} */ (app.document.getElementById('queue-send')).hidden, true);
  } finally {
    app.teardown();
  }
});
```

In `test/server/app-lifecycle.test.js`, add:

```js
test('sending moves a comment from queued to pending', async () => {
  const app = await mountApp({ session: sessionFixture({ comments: [commentFixture({ status: 'open' })] }) });
  try {
    assert.equal(app.document.getElementById('queue-open')?.textContent, 'Queued 1');
    assert.equal(app.document.getElementById('pending-open')?.textContent, 'Pending 0');

    button(app.document, 'send').click();
    await settle();

    assert.equal(app.document.getElementById('queue-open')?.textContent, 'Queued 0');
    assert.equal(app.document.getElementById('pending-open')?.textContent, 'Pending 1');
  } finally {
    app.teardown();
  }
});
```

The shell ships `Pending 0` as static markup, so the pre-Send assertion proves nothing on its own. The pair before and after the Send is what makes it real.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server/queue.test.js test/server/app-panels.test.js test/server/app-lifecycle.test.js`
Expected: the queue test fails because `GROUPS.pending` is undefined, and the jsdom tests fail because `#pending-open` does not exist.

- [ ] **Step 3: Add the group**

In `src/server/public/queue.js`, `GROUPS` becomes:

```js
export const GROUPS = {
  queued: ['open'],
  pending: ['sent'],
  answered: ['answered'],
  resolved: ['resolved'],
};
```

- [ ] **Step 4: Add the panel's labels**

In `src/server/public/app.js`, insert into `PANELS` between `queued` and `answered`:

```js
  pending: {
    toggle: 'pending-open',
    title: 'Pending',
    region: 'Pending comments',
    close: 'Close pending comments',
    empty: 'Nothing pending. Comments you send wait here until the agent answers them.',
  },
```

- [ ] **Step 5: Render the number and wire the toggle**

In `counts()`, add the button's label beside the other three:

```js
  $('pending-open').textContent = `Pending ${shown.pending}`;
```

Put it after the `queue-open` line, so the writes follow the same order as the header.

Beside the other toggle listeners near the end of the file, add:

```js
$('pending-open').addEventListener('click', () => toggleQueuePanel('pending'));
```

- [ ] **Step 6: Add the button to the shell**

In `src/server/ui.js`, between the `queue-open` and `answered-open` buttons:

```html
    <button id="pending-open" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="queue-panel">Pending 0</button>
```

- [ ] **Step 7: Style its active state**

In `src/server/public/styles.css`, add `#pending-open` to the selector list at line 116, so it reads:

```css
#queue-open[aria-expanded="true"],
#pending-open[aria-expanded="true"],
#answered-open[aria-expanded="true"],
#resolved-open[aria-expanded="true"] { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test test/server/queue.test.js test/server/app-panels.test.js test/server/app-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 9: Verify the whole suite and the types**

Run: `npm run check`
Expected: PASS, 744 tests: 740 after Task 1, plus one queue test, two panel tests and one lifecycle test.

- [ ] **Step 10: Confirm in a real browser**

Run: `CODEREVIEW_AXI_PORT=4399 node bin/cr.js open --base main --note "pending panel"`

Check by hand: the header reads Queued, Pending, Answered, Resolved in that order; queue a comment and Send it, and the numbers swap; open Pending and the comment is listed with no Remove button and no Send; the panel's accent fill appears on the Pending button while it is open. Then `CODEREVIEW_AXI_PORT=4399 node bin/cr.js close`.

- [ ] **Step 11: Commit (ask the user first)**

```bash
git add src/server/public/queue.js src/server/public/app.js src/server/ui.js src/server/public/styles.css \
        test/server/queue.test.js test/server/app-panels.test.js test/server/app-lifecycle.test.js
git commit -m "feat(ui): add a Pending group for comments the agent holds"
```

---

## Notes for the executor

- Do not touch the three existing groups' labels or copy. Four tests pin them exactly.
- If a test fails because the app is genuinely wrong, stop and report it rather than fixing the test.
- The README already describes the three groups in the section named "Using the review tab". It needs a line about Pending once this works, which is a `docs:` change and not part of either task above.
