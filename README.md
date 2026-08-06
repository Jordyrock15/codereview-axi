# codereview-axi

[![npm](https://img.shields.io/npm/v/codereview-axi)](https://www.npmjs.com/package/codereview-axi)

### Review your agent's diff where the code is, not in the chat log.

![A cr review session: a diff with a human's question threaded under the line it is about, the agent's answer beneath it, and Queued, Answered and Resolved counts in the header](https://raw.githubusercontent.com/Jordyrock15/codereview-axi/main/media/session.png)

![The Resolved panel open over the diff, listing a resolved thread by file and line, clickable to jump back to it](https://raw.githubusercontent.com/Jordyrock15/codereview-axi/main/media/groups.png)

Reviewing an agent-written diff in a terminal loses the anchor between a comment and the code it is about: line numbers scroll past, and the context is gone by the time a reply arrives.

`cr` opens a browser review session over a git diff instead: the working diff by default, or a branch against its base, or a pull request. A human reads the actual diff, highlights lines, and leaves a comment with intent (fix, explain, ignore). Those comments feed straight back to the coding agent, which replies and refreshes the diff in place.

- **Anchored to code, not to line numbers.** A comment binds to the text you selected, so it follows the code as the agent edits around it.
- **Local-first.** A loopback-only server, a random per-session token, and no cloud in the loop. `cr` never writes to the repository under review.
- **Hands-off between rounds.** You annotate and press Send; the agent collects the batch, fixes, replies, and refreshes without being prompted.

`cr` is an [AXI](https://axi.md), which means:

- It is just a CLI, and any capable agent can run it without setup.
- It is built for agent ergonomics: TOON output, long polling, pre-computed counts, and contextual disclosure, so a round trip costs few tokens.
- The skill and hook below only handle discovery. Agents learn the loop by using it, because every payload ends with the instruction for what to do next.

## Quick start

Install the skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add Jordyrock15/codereview-axi --skill code-review
```

That is the entire setup: no `npm install` needed. The skill teaches your agent to run `cr` through `npx -y codereview-axi`, so the CLI comes along on demand. For restricted sandboxes, CI, or harnesses where `npx -y` exits opaquely, it also documents the installed-copy fallbacks. Its frontmatter carries Hermes Agent metadata, so Hermes-compatible harnesses can surface it as a first-class productivity skill.

By default the skill lands in the current project's skills directory (`.claude/skills/`, for example); add `-g` to install it for all projects (`~/.claude/skills/`).

Then just ask, and the agent loads the skill when it recognises the task:

> review these changes with me

Or, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/code-review the payout splitter
```

The skill covers the trigger and the loop, including the rule that keeps `cr wait` in the foreground: a poll pushed into the background returns comments to a process nobody is listening to, and the human waits on an agent that has moved on.

You need Node 20.19 or newer and `git` on `PATH`. `gh` is needed only for `--pr`. There are no runtime dependencies and no build step.

## Other ways to run it

The skill is the recommended path, but it is not the only one.

### Zero setup

Run it straight from npm, or install it globally:

```sh
npx -y codereview-axi open
```

```sh
npm install -g codereview-axi
cr open --note "refactored the payout splitter"
```

Then say it once to your agent, and keep it short:

> There is a review open, pick it up with `cr`.

Deliberately, a bare `cr` with no session open carries no instruction to act. It falls back to usage, because an agent should not start a review nobody asked for: opening one is the human's call.

### Session hook

`cr setup` installs a `SessionStart` hook so a fresh conversation starts already knowing a review is waiting, instead of the agent having to think to ask. Run it once, then start reviews from your own terminal and never mention `cr` to the agent again:

```sh
cr setup
cr open --note "refactored the payout splitter"
```

Your next agent turn begins by seeing the live session and being told to collect it:

```
next_step: A review is already open. Run `cr wait` to pick up whatever is waiting.
```

From there it is hands-off. You annotate, press Send, and the fixes come back without you prompting between rounds.

The hook runs this install's `cr` with no arguments via an absolute path rather than one resolved through `PATH`. It is an explicit, human-run command, never something the tool does on its own: writing to a Claude Code configuration file unasked is not a review tool's business. By default it targets `.claude/settings.local.json` at the repository root, the personal, git-ignored settings file; `--global` targets `~/.claude/settings.json` instead.

It merges into whatever is already there, preserving unrelated hooks and settings. Running it again reports `already-present` and changes nothing. A settings file that fails to parse is left exactly as it is, and `cr setup` exits 1 rather than risk overwriting it.

To check it worked, open a new Claude Code session after a `cr open` has been started elsewhere: the session should start already showing the live review state. This is not covered by any automated test here; it needs a real Claude Code session to observe.

## Using the review tab

The browser tab is where you do the reviewing; everything else is the agent's side of the loop.

- **Click a line number** in the gutter to comment on that line. **Shift-click** another line in the same hunk to select a range. Crossing into a different hunk starts a fresh selection instead of extending, because the unchanged lines between two hunks are not in the diff and a comment spanning them would not match the file.
- **Pick an intent**: `fix` asks the agent to change the code, `explain` asks it to justify the code and change nothing, `ignore` acknowledges and drops it.
- **Queue** saves the comment as a draft. Nothing reaches the agent yet.
- **Queued n** in the header lists everything drafted, so you can read the batch back and remove anything before committing to it.
- **Send** hands the whole batch over. The header then reads `waiting for agent` until it collects them, and `agent has it` while it works.
- **Pending n** holds what the agent has and owes a reply on, and opens the same shared panel on that group. Its rows carry no **Remove**: the comment is already in the agent's hands, and withdrawing it behind the agent's back would leave the two sides disagreeing about what is outstanding.
- Answers arrive **threaded under your comment**, and the diff refreshes in place once the agent has made its changes. **Reply** adds a follow-up to the same thread; **Resolve** closes it.
- **Answered n** and **Resolved n** sit beside Pending and open the same panel on a different group, so a thread you resolve collects somewhere you can find it again. Clicking any row jumps to that comment, switching file first if it is in another one. Only queued rows offer **Remove**: an answered comment has already been sent, and dropping it would take the agent's reply with it.
- **Done** ends the session and tells the agent to stop. The header then reads `disconnected`, and the server shuts itself down once no session is left open.

The header carries the branch you are reviewing and its base, with whatever the agent last said to you dimmed beside it. The sidebar counts each file's added and removed lines in the diff's own green and red, and shows a file's open comment count instead once it has any.

Long lines wrap rather than scrolling sideways, and the sidebar and the diff scroll independently, so a long file list does not cost you your place in the diff.

A comment is anchored to the **text** you selected, not to a line number, so it follows the code as the agent edits around it. If the quoted text disappears entirely the comment is marked `stale` rather than silently pointing at the wrong line.

## How it works

You do not have to teach your agent the loop. Every payload ends with a `next_step`: one imperative instruction, the last key so it prints last, addressed to the agent rather than describing state. `help[]` stays the command templates, ready to paste; `next_step` is the reason to run one of them right now rather than stopping to report to the human.

The loop it drives:

1. `cr open --note "refactored the payout splitter"`. Prints the session URL, opens a tab.
2. `cr wait --timeout 300 --say "biggest change is the rounding, check that first"`. Blocks until the human annotates and presses Send. Comments return as TOON, or JSON under `--json`.
3. Handle each comment by verdict: `fix` edits the code, `explain` writes a justification and changes nothing, `ignore` is acknowledged and dropped.
4. `cr reply` per comment. Once every `fix`-verdict comment has a reply, `cr refresh` pushes a new snapshot; the tab updates over SSE and threads show the replies. Skip `cr refresh` if nothing in the batch was verdict `fix`, since an `explain` or `ignore` reply changes no code.
5. Back to step 2. When the response carries `closed: true` with `closedBy: "human"`, the review is over: stop, and do not reopen the session uninvited.

Each step is what `next_step` says at that point. After `open` it says to run `cr wait` without killing it. After `wait` returns comments it says to reply to each and to locate them by `quote` rather than by line numbers, since a comment re-anchors to its quoted text as the code around it moves. After `wait` times out with nothing sent it says to poll again rather than treating the review as over. Once a payload carries `closed: true` it says to stop and summarise. Structured errors carry one too where there is something specific to do, for example retrying `agent-waiting` or not retrying `usage`; a slug with no specific advice carries none. `--no-help` suppresses `next_step` alongside `help[]`, on the same reasoning: a human reading suppressed output does not want to be instructed either.

If the server dies mid-`wait`, `cr wait` exits 1 with the `server-unreachable` slug so the agent reports the failure rather than looping. Sent comments stay queued; re-running `wait` picks them up.

### What comes back

`wait` and `list` print each comment as `id`, `file`, `lines`, `verdict`, `body` and `quote` by default, the fields an agent acts on. `body` is the latest human message in the thread: the opening comment, unless the human has since added a follow-up, in which case it is that follow-up. `--fields all` asks for everything else too (`scope`, `status`, `replies`, `createdAt`, `updatedAt`); `replies` is the whole thread flattened to one string, opening message first, so the agent can see what it already answered. `--fields id,quote` asks for a specific subset. `deliveredAt` is internal delivery bookkeeping and is never available, at any `--fields` value.

`body` and `quote` truncate past 2000 characters, with a hint naming the field and the total, because a human can quote a 1500-line selection and hand it straight back. `--full` on `wait` or `list` disables this.

`cr reply` prints a minimal confirmation instead: `id`, `status`, `counts` (the same tally `close` prints, `total` plus one entry per comment status present) and `fix` (`outstanding`: verdict-`fix` comments still awaiting a reply; `justFixed`: whether this particular reply answered a verdict-`fix` comment). The agent already knows the body it sent, so nothing else comes back. `next_step` uses `fix` rather than `counts` to decide whether refresh is worth mentioning: while `fix.outstanding` is above zero it says to keep replying; once it drops to zero, `justFixed` says to refresh, and a reply that answered an `explain` says to skip straight to `cr wait`. It keys on the reply just made rather than a running total, so an explain-only reply never claims a refresh is owed just because some earlier fix was answered.

## CLI reference

```
usage: cr <verb> [flags]

  open      start or resume a review, against a base ref or a pull request
  wait      block until the human sends comments
  list      print comments without blocking
  reply     answer one comment
  refresh   recompute the diff and push it to the tab
  close     end the session
  setup     install a Claude Code hook so every session starts knowing about a review

run `cr <verb> --help` for a verb's flags

every verb accepts --json to print JSON instead of TOON

every verb appends help[] lines suggesting the next command; --no-help suppresses them

--version prints the installed version and exits 0
```

By default `open` reviews the working diff (`git diff HEAD`). `--base <ref>` reviews the current branch against `git diff $(git merge-base <ref> HEAD)` instead, so independent work on the base branch since it diverged stays out of the diff. `--pr <number>` resolves a pull request's base and head branch through `gh` and reviews it the same way as `--base <baseRefName>` would, but only if the current branch is already the PR's head: if it is not, `cr` refuses and prints the `git fetch`/`git switch` command to run rather than checking out the branch itself. `--pr` and `--base` cannot be combined. `refresh` recomputes against whichever surface the session was opened with, and reopening a session with a different base or PR is refused rather than silently swapped.

`--pr` needs `gh` on `PATH`, authenticated against GitHub. Without it, `--pr` exits 1 with a message saying so; use `--base` instead if `gh` is unavailable.

`--version` prints the installed version and exits 0. It is accepted on any invocation and checked before the flag table, so it wins over everything else on the line, including an otherwise-unknown flag.

An unknown verb is a structured error like any other, `code: usage`, so it is safe to parse under `--json` as well as TOON. An unknown *flag* (exit 2) is the one output that stays plain prose: there is no code to branch on, the exit code alone tells the two apart.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Ok |
| 1 | Error; the structured error's `code` slug says which kind |
| 2 | Unknown flag |

Every exit-1 error is `{error: {code, message}}` in TOON or JSON. The slugs it uses:

| Slug | Meaning |
|---|---|
| `usage` | the CLI's own argument checks: an unknown verb, a missing or malformed flag, a boolean flag given a value, a stray positional |
| `state` | the world is not in the shape assumed, for example not inside a git worktree or no open session for this directory |
| `nothing-to-review` | the diff being reviewed is empty |
| `server-unreachable` | the server never came up, died mid-request, or cannot be reached over loopback |
| `bad-response` | the server answered but the body could not be parsed |
| `not-found` | no such session or resource on the server |
| `session-closed` | the session has ended; terminal, do not retry |
| `agent-waiting` | another agent already holds the poll on this session; retry later |
| `invalid-input` | the server rejected the request body itself, for example an unrecognised `--status` value |
| `conflict` | the request conflicts with the session's current state some other way, for example reopening with a different base, or replying to a comment that is not awaiting one |
| `diff-too-large` | the diff overran git's output buffer; try a narrower base or a smaller diff |
| `server-error` | the server rejected the request in a way none of the above covers |
| `error` | an unexpected internal failure the CLI did not classify; report it as a bug rather than branching on it |

## Security

- The server binds to loopback only; it is never reachable from another machine. It starts on demand and stops itself once the last open session closes, so a finished review leaves no process behind holding a port. A session whose worktree no longer exists does not count as open: nothing can close it through the UI, since there is no tree left to open a tab against, and before 0.1.8 one such session kept every daemon alive indefinitely.
- Each session gets a random per-session token, required on every API request either as an `x-cr-token` header or a `?t=` query parameter.
- Every request is checked against the Host header and, when present, the Origin header; anything that is not `127.0.0.1` or `localhost` on the session's own port is rejected.
- State is written to `~/.codereview-axi/state.json` with file mode `0600`.
- `cr` never writes to the repository under review, and never checks anything out, fetches, or switches branches, even for `--pr`: if the current branch is not the PR's head, `cr` refuses and prints the command to run rather than doing it. It reads the diff and holds comments in its own state file; this is proven by an integration test that asserts the repository is byte-identical after a full session. Beyond `git`, `cr` spawns `gh` for `--pr`, to read PR metadata, never to fetch or check out, and it spawns the platform's own browser opener (`open` on macOS, `xdg-open` elsewhere) to launch the review tab. `cr setup` is the one deliberate exception: an explicit, human-run command that writes `.claude/settings.local.json` inside the repository, never something a review itself does.
- A file read confines itself to the resolved, real path staying inside the worktree, so a symlink in the diff pointing outside the repository (for example at `~/.ssh/id_rsa`) is refused rather than followed. This matters once the diff under review can come from someone else's pull request. A symlink pointing inside the repository still resolves and reads normally.
- Anyone holding a session's token can read the full diff and comment thread for that session over loopback; that is what the token is for; there is no further access control within a session.

## Not in v1

Deferred to v2, absent by design, so nobody files them as bugs:

- Keyboard navigation beyond focus rings and `Escape` closing the queue panel.
- A separate history pane.
- File-level comments in the UI.
- Chat (the session's `chat` array stays in the shape so v2 can fill it without a migration).
- `--exclude`.
- Virtualised scrolling.
- Bulk resolve.
- Reopening an answered comment. Removed deliberately: it re-sent the same text, so the agent redid the same work. A follow-up on the thread carries new text instead, and queues as a draft so you still choose when to send it.
- Markdown in comment bodies.
- Posting review comments back to GitHub, or reading existing PR comments.
- Any provider other than GitHub, or reviewing an arbitrary rev range beyond a base ref.

The browser files are covered two ways. Every decision the UI makes lives in a pure module with its own tests: `counts.js` for the counters and the send block, `pick.js` for the gutter selection rules, `quote.js` for a quote's contiguity, `labels.js` for the header text, and `activity.js`, `overlay.js`, `queue.js`, `path-label.js`, `pair.js` and `highlight.js` as before. `app.js` keeps only the DOM reads and writes, and those run under jsdom: `test/helpers/dom.js` mounts it against the real page markup with the network faked, and four suites drive rendering, the composer and its drafts, the panels, and sending, closing and the stream.

Two things stay uncovered on purpose. `styles.css` has no tests, because asserting on real layout needs a browser and the suite must run under node alone. And no test can prove what a browser actually paints, so the visual result still rests on someone looking at it.

## Development

```sh
npm run check
```

Runs the typecheck (`tsc --noEmit`) and the full test suite. `jsdom` is the only dev dependency of substance, and it is what lets the DOM layer be tested without a browser; there are still no runtime dependencies.

To run one area on its own:

```sh
node --test test/server/app-composer.test.js
```

Session and server state live under `~/.codereview-axi/` (override with `CODEREVIEW_AXI_HOME`).

The server uses one fixed port, 4390, and that is deliberate: the port is a mutex the operating system enforces, so a second daemon cannot exist. `cr` fails loudly rather than drifting to another port if 4390 is busy. Override it with `CODEREVIEW_AXI_PORT`, which is how you run a second copy, for example a branch build, without touching the daemon serving your real review.
