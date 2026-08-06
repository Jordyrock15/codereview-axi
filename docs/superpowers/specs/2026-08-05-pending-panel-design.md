# A Pending panel for comments the agent holds

Date: 2026-08-05
Status: approved design, not yet implemented

## Problem

The review UI shows how many comments are queued, answered and resolved. It
never shows how many the agent currently holds.

That number already exists. `countsView` in `src/server/public/counts.js`
computes `awaitingAgent` from the comments whose status is `sent`, and it uses
the number for one purpose only: the tooltip that explains why Send is
disabled. So the human sees the effect, a blocked Send button, without seeing
the cause, five comments in flight.

The three visible groups also leave a gap in the lifecycle. A comment moves
from `open` to `sent` to `answered` to `resolved`, and the second step is the
one with no home in the interface.

## Scope

In scope: a fourth group, Pending, holding the comments whose status is `sent`,
with its own header button and its own view of the shared panel.

Out of scope:

- `stale` comments. They keep the text label they have now. A stale comment is
  not something the agent will answer, so counting it as pending would break
  the meaning of the number.
- Splitting pending by delivery. `deliveredAt` distinguishes a comment waiting
  for collection from one the agent picked up, and the activity badge already
  reflects that difference. One number is what this solves.
- Any change to withdrawal. A comment the agent holds must stay unwithdrawable.

## Approach

Reuse the group machinery rather than build a fourth panel.

`GROUPS` in `src/server/public/queue.js` maps a group name to the statuses it
collects, and `groupEntries` turns any such filter into rows. `PANELS` in
`src/server/public/app.js` maps a group name to its toggle, its title, its two
aria labels and its empty copy. The panel itself is one element serving every
group. So a fourth group is data, not new behaviour.

## The change

Five files.

| File | Change |
| --- | --- |
| `src/server/public/queue.js` | `GROUPS` gains `pending: ['sent']` |
| `src/server/public/counts.js` | `CountsView` gains `pending`, taken from the count already computed for the tooltip |
| `src/server/public/app.js` | `PANELS` gains the pending entry, `counts()` writes the button's label, and one listener wires the toggle |
| `src/server/ui.js` | the shell gains the button, reading `Pending 0` |
| `src/server/public/styles.css` | `#pending-open` joins the active-state selector at line 116 |

Order matters in two places, and it is the same order in both: the `GROUPS`
object and the header read open, sent, answered, resolved. So the Pending
button sits between Queued and Answered, and the interface follows a comment's
life from left to right.

The panel entry reads:

- toggle: `pending-open`
- title: `Pending`
- region: `Pending comments`
- close: `Close pending comments`
- empty: `Nothing pending. Comments you send wait here until the agent answers them.`

## One source of truth for the number

`countsView` already counts the `sent` comments. That count is exposed as
`pending` and the blocked-Send tooltip keeps using the same value.

This matters more than it looks. The button's number and the reason Send is
blocked are two views of one fact, so counting `sent` a second time would let
them disagree. A header that says `Pending 0` beside a Send button that refuses
to send is exactly the kind of contradiction that makes a human distrust the
whole display.

## Decisions taken, with their reasons

- **The label is "Pending", not "Sent".** The number states an obligation the
  agent owes, not an action the human finished. Queued already departs from the
  `open` status name, so the vocabulary is not consistent enough to protect.
- **The button always shows, and reads `Pending 0` when empty.** The other three
  behave this way. A control that appears and vanishes shifts its neighbours and
  is easy to miss.
- **The button sits between Queued and Answered.** The header then reads in the
  same order as the lifecycle and as the `GROUPS` object. This moves Answered
  and Resolved one place right, which costs a moment of muscle memory once.
- **No visual emphasis while non-zero.** The accent fill already means "this
  panel is open" in `styles.css`, so a second use would give one colour two
  meanings. The count plus the existing Send tooltip is enough.
- **Send does not open the panel.** The count changes, which is the feedback.
  The panel's own Send deliberately closes the panel today, so opening another
  would contradict that.
- **An emptying panel stays open and shows its empty copy.** That is what every
  other group does, and `renderQueuePanel` already handles it, so nothing moves
  under the human on a background event.

## Questions the code already answered

- **A pending comment cannot go stale.** `ANCHORABLE` in
  `src/state/anchor.js:8` is `['open']`, so only queued comments re-anchor or
  die. Pending therefore only empties when the agent answers, and the count
  cannot drop without a reply.
- **A fourth group needs no extra wiring.** The outside-click guard reads
  `Object.values(PANELS)` and the aria-expanded loop reads
  `Object.entries(PANELS)`, so both pick up a new group on their own.
- **The agent side needs nothing.** `cr list --status sent` already works
  through the generic status filter, and `src/cli/commands.js:361` already
  computes an `outstanding` count from the same statuses. The gap was only ever
  in the human's view.

## What the panel does not do

No Remove button. Withdrawing a comment the agent already holds would drop the
agent's reply along with it. `renderQueuePanel` already gates Remove on
`group === 'queued'`, so this needs no code.

No panel Send. There is nothing to send from a group that is already sent, and
`renderQueuePanel` already hides the button for any group other than queued.

Both behaviours therefore come for free, and both need a test, because
"already handled" is a claim about code that a future edit can break.

## Tests

- `test/server/counts.test.js`: `pending` counts the `sent` comments and
  nothing else; `pending` is 0 when none are sent; the blocked-Send tooltip
  still names the same number the button shows. One existing test in this file
  asserts the whole `CountsView` object with `deepEqual`, so it needs the new
  field adding or the suite goes red. That is a signal, not a nuisance: the
  `deepEqual` is what stops a field appearing unnoticed.
- `test/server/queue.test.js`: `groupEntries` with `['sent']` returns only the
  sent comments, in the order they were added.
- `test/server/app-panels.test.js`: Pending joins the group table, so its
  title, region label, close label and empty copy are each pinned; the panel
  shows no Remove button for pending; the panel's Send stays hidden for
  pending.
- `test/server/app-lifecycle.test.js`: pressing Send moves the numbers, so
  Queued reads 0 and Pending reads 1 afterwards.

The last one carries the most weight. The shell ships `Pending 0` as static
markup, so a test that reads `Pending 0` on a fresh mount proves nothing about
the app. Driving a real Send first is what makes the assertion real. This trap
appeared five times in the DOM coverage work, so it is worth naming here.

## Verification

`npm run check` must stay green, and the test count must rise. Then open a real
review with `cr`, send a comment, and confirm the Pending button counts it, the
panel lists it, it carries no Remove button, and the number returns to 0 once
the agent answers.

## Risks

- The header gains a seventh control. It is a busy row already. The button
  earns its place because it explains the blocked Send, but if the row wraps
  badly at a narrow width, the fix is the header's layout, not this feature.
- `queuedText` in `queue.js` shows the last human message rather than the
  opening comment, which is right for a queued follow-up. A pending entry shows
  the same text, which is also right: it is what the agent was sent.
