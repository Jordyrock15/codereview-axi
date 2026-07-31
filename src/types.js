/**
 * One line inside a diff hunk.
 * @interface DiffLine
 * @typedef {Object} DiffLine
 * @property {'context'|'add'|'del'} kind — Whether the line is unchanged, added, or removed.
 * @property {string} text — Line content without the leading +/-/space marker.
 * @property {number|null} oldLine — Line number on the old side, null for additions.
 * @property {number|null} newLine — Line number on the new side, null for deletions.
 */

/**
 * A contiguous run of changed lines within a file.
 * @interface Hunk
 * @typedef {Object} Hunk
 * @property {number} oldStart — First line number this hunk covers on the old side.
 * @property {number} oldLines — Line count this hunk covers on the old side.
 * @property {number} newStart — First line number this hunk covers on the new side.
 * @property {number} newLines — Line count this hunk covers on the new side.
 * @property {string} header — Trailing context from the hunk header line, empty string when absent.
 * @property {DiffLine[]} lines — Lines in file order.
 */

/**
 * One changed file as parsed from a unified diff.
 * @interface DiffFile
 * @typedef {Object} DiffFile
 * @property {string} path — Path on the new side, or the old path for deletions.
 * @property {string|null} oldPath — Previous path for renames, otherwise null.
 * @property {'modified'|'added'|'deleted'|'renamed'} status — How the file changed.
 * @property {boolean} binary — True when git reported a binary file and emitted no hunks.
 * @property {number} added — Count of added lines.
 * @property {number} removed — Count of removed lines.
 * @property {Hunk[]} hunks — Empty for binary files.
 * @property {string[]} tags — Empty except for a synthetic entry standing in for a diff header the parser could not decode, which carries 'unparsable'.
 */

/**
 * A changed file enriched for display.
 * @interface SnapshotFile
 * @typedef {Object} SnapshotFile
 * @property {string} path — Path on the new side, or the old path for deletions.
 * @property {string|null} oldPath — Previous path for renames, otherwise null.
 * @property {'modified'|'added'|'deleted'|'renamed'} status — How the file changed.
 * @property {boolean} binary — True when git reported a binary file.
 * @property {number} added — Count of added lines.
 * @property {number} removed — Count of removed lines.
 * @property {Hunk[]} hunks — Empty for binary files.
 * @property {string[]} tags — Any of 'untracked', 'binary', 'generated', 'large', 'unparsable'.
 */

/**
 * The full diff of a worktree at one moment.
 * @interface Snapshot
 * @typedef {Object} Snapshot
 * @property {SnapshotFile[]} files — Changed files, generated ones sorted last.
 * @property {{files: number, added: number, removed: number}} totals — Aggregate counts.
 */

/**
 * A human annotation on the diff.
 * @interface Comment
 * @typedef {Object} Comment
 * @property {number} id — Monotonic per session, starting at 1.
 * @property {'line'|'file'|'session'} scope — What the comment is attached to.
 * @property {string|null} file — Path the comment sits on, null for session scope.
 * @property {'old'|'new'|null} side — Which side of the diff the lines belong to.
 * @property {number|null} startLine — First anchored line, null for file and session scope.
 * @property {number|null} endLine — Last anchored line, null for file and session scope.
 * @property {string} quote — Exact source lines at creation time, the relocation anchor.
 * @property {string} body — What the human wrote.
 * @property {'fix'|'explain'|'ignore'} verdict — What the human wants the agent to do.
 * @property {'open'|'sent'|'answered'|'resolved'|'reopened'|'stale'} status — Lifecycle position.
 * @property {{status: 'fixed'|'explained'|'skipped', body: string, at: string}|null} agentReply — The agent's response, null until replied.
 * @property {string|null} deliveredAt — ISO timestamp of the long-poll delivery, null until delivered.
 * @property {string} createdAt — ISO timestamp.
 * @property {string} updatedAt — ISO timestamp.
 */

/**
 * One review session, keyed by worktree.
 * @interface Session
 * @typedef {Object} Session
 * @property {string} key — Hash of the worktree toplevel path.
 * @property {string} token — Random 32-byte hex secret gating API access.
 * @property {string} repo — Absolute worktree toplevel path.
 * @property {string|null} base — Ref the diff is compared against, null for the working diff.
 * @property {number|null} pr — Pull request number this session reviews, null when opened without `--pr`.
 * @property {string} url — Browser URL including the token.
 * @property {'open'|'closed'} status — Whether the session is live.
 * @property {'human'|'agent'|null} closedBy — Who ended it, null while open.
 * @property {string} note — The agent's description of the change.
 * @property {Snapshot} snapshot — Most recent diff.
 * @property {string} snapshotAt — ISO timestamp of the snapshot.
 * @property {Comment[]} comments — All comments, any status.
 * @property {{role: 'agent'|'human', text: string, at: string}[]} chat — Message log.
 * @property {{holder: number, expiresAt: string}|null} lease — Current waiter, null when free.
 * @property {'unified'|'split'} view — Reading preference, per session, not per file.
 * @property {string} createdAt — ISO timestamp.
 * @property {string} updatedAt — ISO timestamp.
 */

export {};
