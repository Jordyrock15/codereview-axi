const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const CONFIG_NAME = /\.config\.[cm]?[jt]sx?$/;

/**
 * @param {string} path
 * @returns {boolean}
 */
export const isCodeFile = (path) => CODE_EXTENSIONS.some((ext) => path.endsWith(ext));

/**
 * @param {string} path
 * @returns {import('./types.js').NodeKind}
 */
export const classifyFile = (path) => {
  const segments = path.split('/');
  const folders = segments.slice(0, -1);
  const base = segments[segments.length - 1];
  if (base.includes('.test.') || base.includes('.spec.') || folders.includes('Tests') || folders.includes('Fixtures')) return 'test';
  if (base.includes('.stories.')) return 'story';
  if (folders.includes('types') || folders.includes('Types') || base.endsWith('.d.ts')) return 'types';
  if (!isCodeFile(path) || CONFIG_NAME.test(base)) return 'config';
  return 'source';
};
