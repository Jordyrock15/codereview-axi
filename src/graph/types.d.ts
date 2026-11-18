/**
 * Interface representing one changed file that the graph builder reads.
 * @interface IChangedFile
 * @property {string} path — Repo-relative path on the new side.
 * @property {string} status — One of modified, added, deleted or renamed.
 * @property {number} added — Lines added.
 * @property {number} removed — Lines removed.
 */
export interface IChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  added: number;
  removed: number;
}

/**
 * Interface representing one node of the change map.
 * @interface IChangeNode
 * @property {string} id — Repo-relative path of the file, or a folder path with a trailing slash for a group.
 * @property {string} kind — One of source, test, story, types or config.
 * @property {boolean} isNew — True when git reports the file as added.
 * @property {number} added — Lines added.
 * @property {number} removed — Lines removed.
 * @property {number} layer — Column index from the layout, 0 at the left.
 * @property {number} row — Row index inside the column.
 * @property {string[]} [members] — File paths in a folder group.
 */
export interface IChangeNode {
  id: string;
  kind: 'source' | 'test' | 'story' | 'types' | 'config';
  isNew: boolean;
  added: number;
  removed: number;
  layer: number;
  row: number;
  members?: string[];
}

/**
 * Interface representing one link between two changed files.
 * @interface IChangeEdge
 * @property {string} from — Id of the file that imports or tests.
 * @property {string} to — Id of the file that is imported or tested.
 * @property {string} kind — One of import, test or name.
 * @property {boolean} [cycle] — True when the layout broke a cycle at this edge.
 */
export interface IChangeEdge {
  from: string;
  to: string;
  kind: 'import' | 'test' | 'name';
  cycle?: boolean;
}

/**
 * Interface representing the facts about one graph build.
 * @interface IChangeGraphMeta
 * @property {boolean} typescript — True when a TypeScript JS API resolved the imports.
 * @property {string} typescriptFrom — One of bundled or none.
 * @property {string|null} typescriptVersion — Version of the TypeScript that the builder used, null for none.
 * @property {string|null} repoTypescript — Version of the reviewed repo's TypeScript, read as text, null when the repo has none.
 * @property {string} message — One line for a surface to print.
 * @property {number} ms — Build time in milliseconds.
 * @property {number} version — Graph format version, 1 for file level.
 */
export interface IChangeGraphMeta {
  typescript: boolean;
  typescriptFrom: 'bundled' | 'none';
  typescriptVersion: string | null;
  repoTypescript: string | null;
  message: string;
  ms: number;
  version: number;
}

/**
 * Interface representing the change map of one diff.
 * @interface IChangeGraph
 * @property {IChangeNode[]} nodes — One node for each changed file or folder group.
 * @property {IChangeEdge[]} edges — Links where both ends are changed files.
 * @property {IChangeGraphMeta} meta — Facts about the build.
 */
export interface IChangeGraph {
  nodes: IChangeNode[];
  edges: IChangeEdge[];
  meta: IChangeGraphMeta;
}

/**
 * Kind of one node of the change map.
 */
export type NodeKind = IChangeNode['kind'];

/**
 * Builds the change map for a list of changed files under a repo root.
 */
export type BuildChangeGraph = (root: string, files: IChangedFile[]) => IChangeGraph;
