# codereview-axi

Reviewing an agent-written diff in a terminal loses the anchor between a comment and the code it is about: line numbers scroll past, context is gone by the time a reply arrives. `cr` opens a browser review session over your git working diff instead. A human reads the actual diff, highlights lines, and leaves a comment with intent (fix, explain, ignore); those comments feed straight back to the coding agent as JSON, and the agent replies and refreshes the diff in place.

## Install

Run it without installing:

```sh
npx -y codereview-axi open
```

Or install it globally:

```sh
npm install -g codereview-axi
cr open
```

## Quick start

```sh
cr open --note "refactored the payout splitter"
cr wait --timeout 300 --say "biggest change is the rounding, check that first"
cr reply --id 1 --status fixed --body "rounded to the nearest penny before the split"
cr refresh
cr close
```

`open` starts the session and opens a tab. `wait` blocks until the human sends comments or the session closes. Each comment gets a `cr reply`, then `cr refresh` pushes the updated diff into the open tab. `cr close` ends the session when the agent is done.

## Verbs

```
usage: cr <verb> [flags]

  open     [--note TEXT] [--no-browser]   start or resume a review of the working diff
  wait     [--timeout 300] [--say TEXT]   block until the human sends comments
  list     [--status open]                 print comments without blocking
  reply    --id N --status S --body TEXT   answer one comment (fixed|explained|skipped)
  refresh                                  recompute the diff and push it to the tab
  close                                    end the session
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Ok |
| 1 | Usage or state error, for example not a git worktree, no open session, or a rejected request |
| 2 | Nothing to review, the working diff is empty |
| 3 | Server unreachable, for example it died mid-`wait` |

## How the agent should drive it

1. `cr open --note "refactored the payout splitter"`. Prints the session URL, opens a tab.
2. `cr wait --timeout 300 --say "biggest change is the rounding, check that first"`. Blocks until the human annotates and presses Send. Comments return as JSON.
3. Handle each comment by verdict: `fix` edits the code, `explain` writes a justification and changes nothing, `ignore` is acknowledged and dropped.
4. `cr reply` per comment, then `cr refresh` to push a new snapshot; the tab updates over SSE and threads show the replies.
5. Back to step 2. When the response carries `closed: true` with `closedBy: "human"`, the review is over: stop, and do not reopen the session uninvited.

If the server dies mid-`wait`, `cr wait` exits 3 so the agent reports the failure rather than looping. Sent comments stay queued; re-running `wait` picks them up.

## Security

- The server binds to loopback only; it is never reachable from another machine.
- Each session gets a random per-session token, required on every API request either as an `x-cr-token` header or a `?t=` query parameter.
- Every request is checked against the Host header and, when present, the Origin header; anything that is not `127.0.0.1` or `localhost` on the session's own port is rejected.
- State is written to `~/.codereview-axi/state.json` with file mode `0600`.
- `cr` never writes to the repository under review. It reads the working diff and holds comments in its own state file; this is proven by an integration test that asserts the repository is byte-identical after a full session.
- Anyone holding a session's token can read the full diff and comment thread for that session over loopback; that is what the token is for; there is no further access control within a session.

## Not in v1

Deferred to v2, absent by design, so nobody files them as bugs:

- Keyboard navigation.
- A separate history pane.
- File-level comments in the UI.
- Chat (the session's `chat` array stays in the shape so v2 can fill it without a migration).
- `--exclude`.
- Side-by-side view.
- Virtualised scrolling.
- Bulk resolve.
- Markdown in comment bodies.
- A Claude Code skill wrapper.

The browser UI itself has no automated test coverage in v1; it rests on manual verification.

## Development

```sh
npm run check
```

Runs the typecheck (`tsc --noEmit`) and the full test suite. Session and server state live under `~/.codereview-axi/` (override with `CODEREVIEW_AXI_HOME`).
