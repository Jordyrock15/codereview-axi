# codereview-axi

Reviewing an agent-written diff in a terminal loses the anchor between a comment and the code it is about: line numbers scroll past, context is gone by the time a reply arrives. `cr` opens a browser review session over a git diff instead: the working diff by default, or a branch against its base, or a pull request. A human reads the actual diff, highlights lines, and leaves a comment with intent (fix, explain, ignore); those comments feed straight back to the coding agent as JSON, and the agent replies and refreshes the diff in place.

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

  open      start or resume a review, against a base ref or a pull request
  wait      block until the human sends comments
  list      print comments without blocking
  reply     answer one comment
  refresh   recompute the diff and push it to the tab
  close     end the session

run `cr <verb> --help` for a verb's flags
```

By default `open` reviews the working diff (`git diff HEAD`). `--base <ref>` reviews the current branch against `git diff $(git merge-base <ref> HEAD)` instead, so independent work on the base branch since it diverged stays out of the diff. `--pr <number>` resolves a pull request's base and head branch through `gh` and reviews it the same way as `--base <baseRefName>` would, but only if the current branch is already the PR's head: if it is not, `cr` refuses and prints the `git fetch`/`git checkout` command to run rather than checking out the branch itself. `--pr` and `--base` cannot be combined. `refresh` recomputes against whichever surface the session was opened with, and reopening a session with a different base or PR is refused rather than silently swapped.

`--pr` needs `gh` on `PATH`, authenticated against GitHub. Without it, `--pr` exits 1 with a message saying so; use `--base` instead if `gh` is unavailable.

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
- `cr` never writes to the repository under review, and never checks anything out, fetches, or switches branches, even for `--pr`: if the current branch is not the PR's head, `cr` refuses and prints the command to run rather than doing it. It reads the diff and holds comments in its own state file; this is proven by an integration test that asserts the repository is byte-identical after a full session. Beyond `git`, `cr` spawns `gh` for `--pr`, to read PR metadata, never to fetch or check out, and it spawns the platform's own browser opener (`open` on macOS, `xdg-open` elsewhere) to launch the review tab.
- A file read confines itself to the resolved, real path staying inside the worktree, so a symlink in the diff pointing outside the repository (for example at `~/.ssh/id_rsa`) is refused rather than followed. This matters once the diff under review can come from someone else's pull request. A symlink pointing inside the repository still resolves and reads normally.
- Anyone holding a session's token can read the full diff and comment thread for that session over loopback; that is what the token is for; there is no further access control within a session.

## Not in v1

Deferred to v2, absent by design, so nobody files them as bugs:

- Keyboard navigation.
- A separate history pane.
- File-level comments in the UI.
- Chat (the session's `chat` array stays in the shape so v2 can fill it without a migration).
- `--exclude`.
- Virtualised scrolling.
- Bulk resolve.
- Markdown in comment bodies.
- A Claude Code skill wrapper.
- Posting review comments back to GitHub, or reading existing PR comments.
- Any provider other than GitHub, or reviewing an arbitrary rev range beyond a base ref.

The browser UI itself has no automated test coverage in v1; it rests on manual verification.

## Development

```sh
npm run check
```

Runs the typecheck (`tsc --noEmit`) and the full test suite. Session and server state live under `~/.codereview-axi/` (override with `CODEREVIEW_AXI_HOME`).
