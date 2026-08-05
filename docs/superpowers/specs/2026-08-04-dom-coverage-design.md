# DOM coverage for the review UI

Date: 2026-08-04
Status: implemented, PR #29

## Problem

`src/server/public/app.js` has 1123 lines and no automated coverage. It is the
largest file in the repo. Every other module has tests. The pure helpers in
`src/server/public/` (`highlight.js`, `pair.js`, `activity.js`, `overlay.js`,
`queue.js`, `path-label.js`) each have a test file under `test/server/`.

`app.js` cannot run in node today. It reads `document.body.dataset.key` at
import time. UI defects therefore reach the browser unchecked. Several such defects
shipped and needed a fix in recent releases.

## Scope

In scope: full test coverage of `app.js` behaviour.

Out of scope: `src/server/public/styles.css`. Assertions on real layout need a
browser. The suite must stay runnable with node alone.

## Approach

Two layers.

1. Move every decision out of `app.js` into small pure modules. Test those
   modules directly in node, the way `queue.js` is tested now.
2. Load the remaining DOM code under jsdom with a stubbed network. Test each
   renderer and each event handler at least once.

`jsdom` becomes a dev dependency. No runtime dependency changes.

## Layer 1: extraction

New modules in `src/server/public/`.

| Module | Exports | Source |
| --- | --- | --- |
| `counts.js` | `countsView(comments)` | the decision half of `counts()`, with the mid-round send rule and its wording |
| `pick.js` | `nextPick(pick, click)`, `pickRange(pick)`, `inPickRange(line, side, pick)`, `draftKey(pick)` | the shift-extend, same-side and same-hunk rules in `pickHandler`, and the range maths repeated in four places |
| `quote.js` | `buildQuote(rows, from, to)` | the contiguity judgement in `quoteFromRows` |
| `labels.js` | `identLabel(session)`, `viewToggleLabel(session)`, `noteTitle(ident, said)` | the PR, branch and base ladder in `load()` |

`activityLabel(state)` goes into the existing `activity.js`. It sits beside
`activityState`, which is the same concern and already has tests.

`countsView` returns `{stale, unsent, answered, resolved, staleLabel,
sendLabel, sendDisabled, sendTitle}`.

`nextPick` returns `{pick, shiftExtend, rejected}`.

`buildQuote` takes `{line, hunk, text}[]` and returns `{quote, contiguous,
rowCount}`. `app.js` keeps the DOM read that builds those rows.

Behaviour must not change. `app.js` keeps every DOM read and every DOM write.
It calls these modules for each decision. It loses about 120 lines.

## Layer 2: the jsdom harness

`test/helpers/dom.js` exports one function, `mountApp(options)`.

The harness must:

- Build the page from `shellHtml(key)` in `src/server/ui.js`. The real markup
  keeps the ids in the tests and the ids in the app from drifting apart.
- Use the URL `http://127.0.0.1:4390/s/<key>?t=<token>`, so the token parses as
  it does in the browser.
- Install `document` and `window` as globals, plus a fake `fetch` and a fake
  `EventSource`.
- Stub the three things jsdom does not implement: `scrollIntoView`,
  `window.confirm` and `matchMedia`.
- Route the fake `fetch` over a mutable session fixture. `GET ''` returns the
  session. `POST /comments` appends one. `POST /send` moves statuses. Record
  every request, so a test can assert on the request and on the DOM. Allow a
  per-test override, so a route can return 401, 409 or an `{error}` body.
- Import `app.js` with a cache-busting query, `app.js?n=<counter>`. Each test
  then gets a fresh module with fresh `view`, `picking`, `drafts` and
  `panelGroup`. The ESM cache would otherwise share state between tests.
- Return `{window, document, session, requests, emit, confirmNext, teardown}`.
  `emit('refreshed')` fires a stream event. `confirmNext(false)` cancels Done.
- Clear pending overlay timers and close the window in `teardown`, so the suite
  leaves nothing running.

`app.js` ends with a top-level `await withOverlay(load)`. `await mountApp()`
therefore resolves after the first render. The tests need no sleeps.

`tsconfig.json` needs no change. It sets no `lib`, so the DOM lib is in scope
already. jsdom ships no type declarations, so `@types/jsdom` is a second dev
dependency, pinned at 28, which is the latest published version. The harness
only uses `JSDOM`, the `url` option and `DOMWindow`, and those stay stable
across majors. jsdom itself is pinned to 29, the newest line that still
supports node 20: jsdom 30 needs node 22.22.2 or later, which the package's own
`engines` floor does not require. `test` is inside `include`, so the
harness must carry JSDoc types.

## Layer 3: the tests

Pure modules, in the existing node style:

- `test/server/counts.test.js`: each status counted; an empty stale label at
  zero; the send label and disabled state; blocked while the agent owes a
  reply; singular and plural wording.
- `test/server/pick.test.js`: a plain click starts a range; shift extends
  inside one hunk and side; shift across a hunk or a side restarts and reports
  a rejection; a first shift with nothing picked stays silent; the range maths
  when the end precedes the start; the draft key ignores the end line.
- `test/server/quote.test.js`: one line; a multi-line join; a skipped deleted
  line keeps contiguity; a range across two hunks is not contiguous; no
  matching rows gives a row count of zero; a blank line is a valid quote.
- `test/server/labels.test.js`: PR; branch with a base; branch alone; base
  alone; working tree; the view toggle names the other view; the note title
  with and without a note.
- `test/server/activity.test.js`, extended: the six delivery and polling
  wordings.

jsdom suites, one file per area. Each renderer and each handler runs at least
once. Assertions stay thin, on what matters for that path.

- `app-render.test.js`: the files nav with counts and the generated tag;
  unified rows; split rows; a thread anchored to the last matching row; stale
  and session-scope threads; the activity badge; ident and say; the view label;
  the large-file guard and Render anyway; a binary file; the 401 message.
- `app-composer.test.js`: a gutter click opens the composer; the heading splits
  the path; a shift-extend keeps the typed text; a rejected shift-click shows
  the boundary message; the verdict buttons track `aria-pressed`; Queue posts
  the right body; a server error reaches the warning line; empty text is
  refused; Cancel clears the pick; a draft survives a re-render; a follow-up
  posts; Resolve patches.
- `app-panels.test.js`: the three groups render their own title and aria
  labels; Remove appears only on a queued entry; an outside click closes the
  panel; a click on another toggle switches group; Escape closes the panel
  before it touches a composer; the panel's Send sends and then closes.
- `app-lifecycle.test.js`: Send is disabled while a round is open; Done
  confirms and reaches the closed state; a cancelled confirm changes nothing; a
  `closed` stream event reaches the same closed state; the badge on open and on
  error; `refreshed` reveals the overlay and then clears it; expand fetches
  context and replaces the button.

## Verification

Run `npm run check`, which runs `tsc --noEmit` and the full suite. Then run
`cr` against a real repo and use the UI. The refactor touches shipped UI code,
and no test guarded it before, so a manual pass is needed once.

## Risks

- jsdom does not do layout or CSS, so `styles.css` stays uncovered. This is a
  deliberate choice, to keep the suite runnable without a browser.
- The extraction is the only part that can break real behaviour. It lands as
  its own commit, apart from the tests, so it stays easy to review and to
  revert.
- These commits are `refactor:` and `test:`. release-please does not bump a
  version for either. This work therefore does not exercise the publish
  pipeline. That still waits for the next `fix:` or `feat:`.
