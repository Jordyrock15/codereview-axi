/**
 * @typedef {import('../../types.js').Session} Session
 */

/**
 * A short, stable label for the tab, kept apart from the note. `--say`
 * rewrites the note every round, so using it as the header made the title as
 * long as whatever the agent last said.
 * @param {Pick<Session, 'pr'|'base'|'branch'>} session
 * @returns {string}
 */
export const identLabel = (session) => {
  if (session.pr) return `PR #${session.pr} → ${session.base}`;
  if (session.branch) return `${session.branch}${session.base ? ` → ${session.base}` : ''}`;
  if (session.base) return `→ ${session.base}`;
  return 'working tree';
};

/**
 * Names what a click switches to, read from the session so two tabs cannot
 * disagree, never from local state.
 * @param {Pick<Session, 'view'>} session
 * @returns {string}
 */
export const viewToggleLabel = (session) => (session.view === 'split' ? 'unified' : 'split');

/**
 * @param {string} ident
 * @param {string} said
 * @returns {string}
 */
export const noteTitle = (ident, said) => (said ? `${ident}: ${said}` : ident);
