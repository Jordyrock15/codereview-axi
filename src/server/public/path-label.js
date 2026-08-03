/**
 * A file list label, split so the filename survives when the row is too
 * narrow for the full path: `dir` end-ellipsises, `base` never does.
 * @interface PathLabel
 * @typedef {Object} PathLabel
 * @property {string} dir — Leading directories including the trailing slash, or '' at the repo root.
 * @property {string} base — The filename, always shown in full.
 */

/**
 * @param {string} path
 * @returns {PathLabel}
 */
export const splitPathLabel = (path) => {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', base: path }
    : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
};
