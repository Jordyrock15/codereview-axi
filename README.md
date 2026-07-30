# codereview-axi

`cr` opens a browser review session over your git working diff. A human reviews the change and leaves comments, and those comments feed straight back to your coding agent.

Run it without installing:

```sh
npx -y codereview-axi open
```

## Verbs

- `open`: start a review session for the current worktree's diff.
- `wait`: block until the human replies or the session closes.
- `list`: show open comments.
- `reply`: answer a comment on behalf of the agent.
- `refresh`: push a new snapshot of the diff into a running session.
- `close`: end the session.

## Not yet implemented

Deferred to v2, absent by design:

- Keyboard navigation.
- A separate history pane.
- File-level comments.
- Chat (`cr chat` and `POST /chat`; the session's `chat` array stays in the shape so v2 can fill it without a migration).
- `--exclude`.
- Side-by-side view.
- Virtualised scrolling.
- Bulk resolve.
- Markdown comment bodies.
- A skill wrapper.
