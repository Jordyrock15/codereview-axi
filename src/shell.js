/**
 * POSIX single-quoting: wrap in single quotes, and for each embedded single
 * quote, close the string, insert an escaped one, then reopen it. Used
 * anywhere a message embeds a git ref that did not originate with the local,
 * trusted user, so the ref is safe to paste even when it is built to look
 * like a shell command: a PR's head or base branch name, both read from
 * `gh`, which itself is relaying whatever the PR's author supplied.
 * @param {string} s
 * @returns {string}
 */
export const shQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
