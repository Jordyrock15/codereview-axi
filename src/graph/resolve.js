import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { classifyFile, isCodeFile } from './classify.js';

/** @typedef {import('./types.js').IChangedFile} IChangedFile */
/** @typedef {import('./types.js').IChangeEdge} IChangeEdge */

/**
 * Interface representing one parsed tsconfig project.
 * @interface IProject
 * @typedef {Object} IProject
 * @property {any} options — Compiler options of the project.
 * @property {Set<string>} fileNames — Absolute POSIX paths of the files in the project.
 * @property {any[]} references — Project references of the project.
 * @property {boolean} isRoot — True for the root tsconfig.json.
 */

const NO_INPUTS_FOUND = 18003;

/**
 * @param {string} path
 * @returns {string}
 */
const toPosix = (path) => path.split(sep).join('/');

/**
 * @param {any} ts
 * @param {string} configPath
 * @param {boolean} isRoot
 * @returns {IProject|null}
 */
const parseProject = (ts, configPath, isRoot) => {
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error || !read.config) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
    /** @type {any[]} */
    const errors = parsed.errors ?? [];
    if (errors.some((error) => error.code !== NO_INPUTS_FOUND)) return null;
    return {
      options: parsed.options,
      fileNames: new Set(parsed.fileNames.map((/** @type {string} */ name) => toPosix(resolve(name)))),
      references: parsed.projectReferences ?? [],
      isRoot,
    };
  } catch {
    return null;
  }
};

/**
 * @param {any} ts
 * @param {string} root
 * @returns {IProject[]}
 */
const loadProjects = (ts, root) => {
  const rootConfig = join(root, 'tsconfig.json');
  if (!existsSync(rootConfig)) return [];
  const rootProject = parseProject(ts, rootConfig, true);
  /** @type {IProject[]} */
  const projects = [];
  if (rootProject) projects.push(rootProject);
  /** @type {any[]} */
  const references = rootProject?.references ?? readReferences(ts, rootConfig);
  for (const reference of references) {
    const refPath = isAbsolute(reference.path) ? reference.path : resolve(root, reference.path);
    const project = parseProject(ts, refPath.endsWith('.json') ? refPath : join(refPath, 'tsconfig.json'), false);
    if (project) projects.push(project);
  }
  return projects;
};

/**
 * @param {any} ts
 * @param {string} configPath
 * @returns {any[]}
 */
const readReferences = (ts, configPath) => {
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    return Array.isArray(read.config?.references) ? read.config.references.filter((/** @type {any} */ ref) => typeof ref?.path === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * @param {any} ts
 * @returns {any}
 */
const defaultOptions = (ts) => ({ allowJs: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });

/**
 * @param {any} ts
 * @param {IProject[]} projects
 * @param {string} absFile
 * @returns {any}
 */
const optionsFor = (ts, projects, absFile) => {
  const project = projects.find((p) => p.fileNames.has(absFile))
    ?? projects.find((p) => p.options.paths)
    ?? projects.find((p) => p.isRoot);
  return { ...(project ? project.options : defaultOptions(ts)), allowJs: true };
};

/**
 * @param {string} root
 * @returns {string[]}
 */
const rootsOf = (root) => {
  const roots = [resolve(root)];
  try {
    const real = realpathSync(root);
    if (real !== roots[0]) roots.push(real);
  } catch {}
  return roots;
};

/**
 * @param {string[]} roots
 * @param {string} absPath
 * @returns {string}
 */
const toRepoPath = (roots, absPath) => {
  for (const root of roots) {
    const rel = relative(root, absPath);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel);
  }
  return '';
};

/**
 * @param {any} ts
 * @param {string} root
 * @param {IChangedFile[]} files
 * @returns {IChangeEdge[]}
 */
export const importEdges = (ts, root, files) => {
  const live = new Set(files.filter((f) => f.status !== 'deleted').map((f) => f.path));
  const projects = loadProjects(ts, root);
  const roots = rootsOf(root);
  /** @type {IChangeEdge[]} */
  const edges = [];
  const seen = new Set();
  for (const file of files) {
    if (file.status === 'deleted' || !isCodeFile(file.path)) continue;
    const absFile = toPosix(resolve(root, file.path));
    let text;
    try {
      text = readFileSync(absFile, 'utf8');
    } catch {
      continue;
    }
    const options = optionsFor(ts, projects, absFile);
    const kindOfImporter = classifyFile(file.path);
    const kind = kindOfImporter === 'test' || kindOfImporter === 'story' ? 'test' : 'import';
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      let resolved;
      try {
        resolved = ts.resolveModuleName(imported.fileName, absFile, options, ts.sys).resolvedModule?.resolvedFileName;
      } catch {
        continue;
      }
      if (!resolved) continue;
      const to = toRepoPath(roots, resolved);
      const key = `${file.path}\u0000${to}`;
      if (to === file.path || !live.has(to) || seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: file.path, to, kind });
    }
  }
  return edges;
};

/**
 * @param {string} path
 * @returns {string}
 */
const stemOf = (path) => basename(path).replace(/\.[^.]+$/, '');

/**
 * @param {IChangedFile[]} files
 * @param {IChangeEdge[]} edges
 * @returns {IChangeEdge[]}
 */
export const nameEdges = (files, edges) => {
  const live = files.filter((f) => f.status !== 'deleted').map((f) => f.path);
  const sources = live.filter((path) => classifyFile(path) === 'source').sort();
  const withEdge = new Set(edges.map((e) => e.from));
  /** @type {IChangeEdge[]} */
  const added = [];
  for (const path of live) {
    const kind = classifyFile(path);
    if ((kind !== 'test' && kind !== 'story') || withEdge.has(path)) continue;
    const stem = stemOf(path).replace(/\.(test|spec|stories)$/, '');
    const matches = sources.filter((source) => stemOf(source) === stem);
    const to = matches.find((source) => dirname(source) === dirname(path)) ?? matches[0];
    if (to) added.push({ from: path, to, kind: 'name' });
  }
  return added;
};
