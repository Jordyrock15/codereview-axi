/** @typedef {import('./types.js').IChangeNode} IChangeNode */
/** @typedef {import('./types.js').IChangeEdge} IChangeEdge */
/** @typedef {import('./types.js').NodeKind} NodeKind */

/**
 * Interface representing a list of nodes with the edges between them.
 * @interface IGraphPart
 * @typedef {Object} IGraphPart
 * @property {IChangeNode[]} nodes — Nodes of the graph.
 * @property {IChangeEdge[]} edges — Edges between the nodes.
 */

/** @type {NodeKind[]} */
const KIND_ORDER = ['source', 'test', 'story', 'types', 'config'];
const CONFIG_ROW_WIDTH = 6;

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {string} id
 * @returns {string}
 */
const parentOf = (id) => {
  const trimmed = id.endsWith('/') ? id.slice(0, -1) : id;
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? '' : trimmed.slice(0, cut + 1);
};

/**
 * @param {NodeKind[]} kinds
 * @returns {NodeKind}
 */
const mostCommonKind = (kinds) => {
  const counts = new Map(KIND_ORDER.map((kind) => [kind, 0]));
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  let best = KIND_ORDER[0];
  for (const kind of KIND_ORDER) {
    if ((counts.get(kind) ?? 0) > (counts.get(best) ?? 0)) best = kind;
  }
  return best;
};

/**
 * @param {IChangeEdge[]} edges
 * @param {Map<string, string>} owner
 * @returns {IChangeEdge[]}
 */
const remapEdges = (edges, owner) => {
  const seen = new Set();
  /** @type {IChangeEdge[]} */
  const out = [];
  for (const e of edges) {
    const from = owner.get(e.from) ?? e.from;
    const to = owner.get(e.to) ?? e.to;
    const key = `${from}\u0000${to}\u0000${e.kind}`;
    if (from === to || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, from, to });
  }
  return out;
};

/**
 * @param {Map<string, string[]>} map
 * @param {string} key
 * @param {string[]} members
 */
const addMembers = (map, key, members) => {
  const list = map.get(key);
  if (list) list.push(...members);
  else map.set(key, [...members]);
};

/**
 * @param {Map<string, string[]>} current
 * @param {(id: string) => string|null} targetOf
 * @returns {Map<string, string[]>}
 */
const regroup = (current, targetOf) => {
  /** @type {Map<string, string[]>} */
  const next = new Map();
  for (const [id, members] of current) addMembers(next, targetOf(id) ?? id, members);
  return next;
};

/**
 * @param {Map<string, string[]>} current
 * @returns {Map<string, string[]>|null}
 */
const mergeSiblings = (current) => {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const id of current.keys()) {
    const parent = parentOf(id);
    if (parent !== '') counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const merging = (/** @type {string} */ id) => (counts.get(parentOf(id)) ?? 0) >= 2;
  if (![...current.keys()].some(merging)) return null;
  return regroup(current, (id) => (merging(id) ? parentOf(id) : null));
};

/**
 * @param {string} folder
 * @returns {number}
 */
const depthOf = (folder) => folder.split('/').length - 1;

/**
 * @param {Map<string, string[]>} current
 * @returns {Map<string, string[]>|null}
 */
const promoteDeepest = (current) => {
  const deepest = Math.max(0, ...[...current.keys()].map((id) => depthOf(parentOf(id))));
  if (deepest === 0) return null;
  return regroup(current, (id) => (depthOf(parentOf(id)) === deepest ? parentOf(id) : null));
};

/**
 * @param {Map<string, string[]>} current
 * @param {(id: string) => boolean} joins
 * @returns {Map<string, string[]>|null}
 */
const mergeRoot = (current, joins) => {
  const joining = new Set([...current.keys()].filter((id) => id !== './' && parentOf(id) === '' && joins(id)));
  if (joining.size === 0 || (joining.size === 1 && !current.has('./'))) return null;
  return regroup(current, (id) => (joining.has(id) ? './' : null));
};

/**
 * @param {IChangeNode[]} nodes
 * @param {IChangeEdge[]} edges
 * @param {number} [limit]
 * @returns {IGraphPart}
 */
export const groupFolders = (nodes, edges, limit = 40) => {
  if (nodes.length <= limit) return { nodes: nodes.map((n) => ({ ...n })), edges: edges.map((e) => ({ ...e })) };
  /** @type {Map<string, IChangeNode>} */
  const files = new Map(nodes.map((n) => [n.id, n]));
  /** @type {Map<string, string[]>} */
  let current = new Map(nodes.map((n) => [n.id, n.members ? [...n.members] : [n.id]]));
  while (current.size > limit) {
    const next = mergeSiblings(current) ?? promoteDeepest(current) ?? mergeRoot(current, (id) => !id.endsWith('/')) ?? mergeRoot(current, () => true);
    if (!next) break;
    current = next;
  }
  /** @type {Map<string, string>} */
  const owner = new Map();
  /** @type {IChangeNode[]} */
  const out = [];
  for (const [id, members] of [...current].sort(([a], [b]) => byText(a, b))) {
    const original = files.get(id);
    if (original) {
      out.push({ ...original });
      continue;
    }
    const sorted = [...members].sort(byText);
    const parts = sorted.map((member) => files.get(member)).filter((n) => n !== undefined);
    for (const member of sorted) owner.set(member, id);
    out.push({
      id,
      kind: mostCommonKind(parts.map((n) => n.kind)),
      isNew: parts.every((n) => n.isNew),
      added: parts.reduce((sum, n) => sum + n.added, 0),
      removed: parts.reduce((sum, n) => sum + n.removed, 0),
      layer: 0,
      row: 0,
      members: sorted,
    });
  }
  return { nodes: out, edges: remapEdges(edges, owner) };
};

/**
 * @param {string[]} ids
 * @param {IChangeEdge[]} edges
 * @returns {Set<IChangeEdge>}
 */
const findBackEdges = (ids, edges) => {
  /** @type {Map<string, IChangeEdge[]>} */
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (e.kind === 'name') continue;
    outgoing.get(e.from)?.push(e);
  }
  for (const list of outgoing.values()) list.sort((a, b) => byText(a.to, b.to) || byText(a.kind, b.kind));
  /** @type {Set<IChangeEdge>} */
  const back = new Set();
  /** @type {Map<string, 'open'|'done'>} */
  const state = new Map();
  /**
   * @param {string} id
   */
  const visit = (id) => {
    state.set(id, 'open');
    for (const e of outgoing.get(id) ?? []) {
      const seen = state.get(e.to);
      if (seen === 'open') back.add(e);
      else if (seen === undefined && outgoing.has(e.to)) visit(e.to);
    }
    state.set(id, 'done');
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  return back;
};

/**
 * @param {string[]} sources
 * @param {IChangeEdge[]} edges
 * @returns {Map<string, number>}
 */
const sourceRanks = (sources, edges) => {
  const isSource = new Set(sources);
  /** @type {Map<string, string[]>} */
  const next = new Map(sources.map((id) => [id, []]));
  for (const e of edges) {
    if (isSource.has(e.from) && isSource.has(e.to)) next.get(e.from)?.push(e.to);
  }
  /** @type {Map<string, number>} */
  const ranks = new Map();
  /**
   * @param {string} id
   * @returns {number}
   */
  const rankOf = (id) => {
    const known = ranks.get(id);
    if (known !== undefined) return known;
    const rank = Math.max(-1, ...(next.get(id) ?? []).map(rankOf)) + 1;
    ranks.set(id, rank);
    return rank;
  };
  for (const id of sources) rankOf(id);
  return ranks;
};

/**
 * @param {IChangeNode[]} nodes
 * @param {IChangeEdge[]} edges
 * @returns {IGraphPart}
 */
export const layoutGraph = (nodes, edges) => {
  const sorted = [...nodes].sort((a, b) => byText(a.id, b.id));
  const ids = sorted.map((n) => n.id);
  const back = findBackEdges(ids, edges);
  const outEdges = edges.map((e) => (back.has(e) ? { ...e, cycle: true } : { ...e }));
  const ranked = edges.filter((e) => !back.has(e) && e.kind !== 'name');
  const sources = sorted.filter((n) => n.kind === 'source').map((n) => n.id);
  const ranks = sourceRanks(sources, ranked);
  const maxRank = Math.max(0, ...ranks.values());
  const typesColumn = sources.length > 0 ? 2 + maxRank : 1;

  /** @type {Map<string, number>} */
  const layer = new Map();
  const configs = [];
  for (const n of sorted) {
    if (n.kind === 'config') configs.push(n.id);
    else if (n.kind === 'test' || n.kind === 'story') layer.set(n.id, 0);
    else if (n.kind === 'types') layer.set(n.id, typesColumn);
    else layer.set(n.id, 1 + maxRank - (ranks.get(n.id) ?? 0));
  }

  /** @type {Map<string, string[]>} */
  const links = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    links.get(e.from)?.push(e.to);
    links.get(e.to)?.push(e.from);
  }

  /** @type {Map<string, number>} */
  const row = new Map();
  const columns = [...new Set(layer.values())].sort((a, b) => a - b);
  let tallest = 0;
  for (const column of columns) {
    const members = ids.filter((id) => layer.get(id) === column);
    tallest = Math.max(tallest, members.length);
    const placed = members.map((id) => {
      const rows = (links.get(id) ?? [])
        .filter((other) => (layer.get(other) ?? Infinity) < column)
        .map((other) => row.get(other) ?? 0);
      return { id, mean: rows.length > 0 ? rows.reduce((sum, r) => sum + r, 0) / rows.length : null };
    });
    const linked = placed.filter((p) => p.mean !== null).sort((a, b) => (a.mean ?? 0) - (b.mean ?? 0) || byText(a.id, b.id));
    const unlinked = placed.filter((p) => p.mean === null);
    [...linked, ...unlinked].forEach((p, index) => row.set(p.id, index));
  }
  configs.forEach((id, index) => {
    layer.set(id, index % CONFIG_ROW_WIDTH);
    row.set(id, tallest + Math.floor(index / CONFIG_ROW_WIDTH));
  });

  return {
    nodes: nodes.map((n) => ({ ...n, layer: layer.get(n.id) ?? 0, row: row.get(n.id) ?? 0 })),
    edges: outEdges,
  };
};
