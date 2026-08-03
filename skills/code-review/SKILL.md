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

## Workflow

1. Open the session with `cr open` (see above). It prints the URL and opens a tab.
2. Run `cr wait` to long-poll for the human's comments. Add `--say "<what to look at first>"` on the first wait so the tab opens with context.
   `cr wait` stays silent until the human presses Send or ends the session, so **leave it running and never kill it.** That silence is the normal state, not a hang, and not a reason to give up on the poll or to go and report to the human.
   Keep the wait in the **foreground** by default and let it return the comments straight to you. A background wait is acceptable only through a harness-native tracked background-job facility whose completion is guaranteed to resume or notify the same agent. Never use `nohup`, a shell `&`, `disown`, a redirected fire-and-forget process, or a detached terminal merely to keep the poll alive: the comments come back to a process nobody is listening to, and the human waits forever on an agent that has moved on. If your harness has no completion-aware background facility, use the foreground wait. Do not tell the human the review is being watched until that path is live.
   If the wait is killed or times out anyway, just run it again. Sent comments stay queued and are never lost.
3. Act on each comment by its verdict: `fix` edits the code, `explain` writes a justification and changes nothing, `ignore` is acknowledged and dropped.
4. Run one `cr reply` per comment, with a status reflecting what you actually did.
5. Once every `fix`-verdict comment has a reply, run `cr refresh` to push the new diff into the open tab. Skip it when the batch contained no `fix`, since an `explain` or `ignore` reply changed no code.
6. Go back to step 2 without stopping to report. The human is in the tab, not in the chat, and a summary between rounds is a round they spend waiting.
7. When a payload carries `closed: true`, the review is over. Summarise for the human, and do not reopen the session uninvited.

**Every payload also ends with a `next_step`: one imperative instruction for what to do right now.** It knows the session's actual state, so where it and this file disagree, follow it.

Three mistakes here fail silently, which is why they are worth stating outright:

- **Locate code by a comment's `quote`, never by its line numbers.** Comments re-anchor to quoted source text as the code moves, so the quote is authoritative and the numbers may already be stale from your own edits. If a quote appears more than once in the file, match the whole quoted block rather than a fragment of it.
- **Honour the verdict.** Do not fix something the human asked you to explain.
- **Reply to every comment.** An unanswered comment leaves the human waiting with no sign of it.

## Reading an error

Errors are structured: `{error: {code, message}}`. Branch on the `code` slug, never on the exit code, which is only `0` success, `1` error, `2` unknown flag. `agent-waiting` is retryable. `session-closed` is terminal, so do not reopen. `nothing-to-review` means there is no diff, so tell the human rather than retrying. Slugs carry a `next_step` of their own where there is something specific to do.

## Ambient context

`cr setup` installs a Claude Code `SessionStart` hook so a future session starts already knowing a review is waiting. Suggest it once; **never run it without the human explicitly agreeing**, because it writes to their Claude Code settings.

## Voice

Reply bodies are read by a person mid-review. Say what changed and why, in British English, and keep it to the point.
