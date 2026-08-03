---
name: code-review
description: Review code changes with a human in a browser instead of pasting a diff into the terminal, using the codereview-axi CLI. Use when the user wants to look at changes together, says review this with me / let's review / walk me through the diff / check my changes, or when you are about to hand over a diff large enough that they will want to annotate it rather than read it in chat.
argument-hint: <what to review, or a base ref or PR number>
author: Jordan Barrand (Jordyrock15)
metadata:
  hermes:
    tags: [code-review, diff, git, review, collaboration]
    category: productivity
---

# codereview-axi

`cr` opens a browser review session over a git diff. The human reads the real diff, selects lines, and leaves a comment with an intent (`fix`, `explain`, `ignore`). Those comments come back to you, you act on them, and you reply on the thread. The diff refreshes in place as you make changes.

Use it instead of pasting a diff into the conversation whenever the human will want to point at specific lines.

You do not need it installed globally: `npx -y codereview-axi open`. If the tool's own output suggests a follow-up command beginning with `cr`, run it as `npx -y codereview-axi ...` instead. In restricted sandboxes or agent harnesses where `npx -y` exits opaquely, use an installed copy directly: `node "$(npm root)/codereview-axi/bin/cr.js"` for a local install, `node "$(npm root -g)/codereview-axi/bin/cr.js"` for a global one, or the bare `cr` bin once installed.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked this explicitly: start a review of what it describes now. A bare ref name means `--base <ref>`; a number means `--pr <number>`. If it is empty, infer the surface from the conversation, defaulting to the working diff.

## Starting a review

Pick the surface, then open it:

| Reviewing | Command |
|---|---|
| Uncommitted work, the default | `cr open` |
| A branch against where it diverged | `cr open --base main` |
| A pull request | `cr open --pr 123` |

Add `--note "<what you changed>"` so the tab header says what this review is about. `open` prints a URL and opens a tab; give the human the URL in case it did not.

`--pr` resolves the base and head through `gh` and **refuses rather than checking out** if the local branch is not the PR's head. Relay the command it prints; do not run it yourself unless asked. `cr` never writes to the repository under review.

## Then follow the output, not this file

**Every payload ends with a `next_step`: one imperative instruction telling you what to do next. Follow it.** That is the loop, and it is deliberately not duplicated here so the two can never disagree.

The only thing worth stating up front, because getting it wrong is silent and costly:

- **Locate code by a comment's `quote`, never by its line numbers.** Comments re-anchor to quoted source text as the code moves, so the quote is authoritative and the numbers may already be stale from your own edits. If a quote appears more than once in the file, match the whole quoted block rather than a fragment of it.
- **Honour the verdict.** `fix` means change the code. `explain` means answer and change nothing. `ignore` means acknowledge and move on. Do not fix something the human asked you to explain.
- **Reply to every comment**, one `cr reply` each, with a status reflecting what you actually did. An unanswered comment leaves the human waiting with no sign of it.
- **Do not stop to report between rounds** unless `next_step` says to. `cr wait` blocks silently until the human presses Send; that silence is normal and is not a reason to give up on the poll.

## Reading an error

Errors are structured: `{error: {code, message}}`. Branch on the `code` slug, never on the exit code, which is only `0` success, `1` error, `2` unknown flag. `agent-waiting` is retryable. `session-closed` is terminal, so do not reopen. `nothing-to-review` means there is no diff, so tell the human rather than retrying. Slugs carry a `next_step` of their own where there is something specific to do.

## Ambient context

`cr setup` installs a Claude Code `SessionStart` hook so a future session starts already knowing a review is waiting. Suggest it once; **never run it without the human explicitly agreeing**, because it writes to their Claude Code settings.

## Voice

Reply bodies are read by a person mid-review. Say what changed and why, in British English, and keep it to the point.
