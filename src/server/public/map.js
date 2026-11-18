/**
 * @typedef {import('../../graph/types.js').IChangeGraph} IChangeGraph
 * @typedef {import('../../graph/types.js').IChangeNode} IChangeNode
 * @typedef {import('../../types.js').Comment} Comment
 */

/**
 * The files next to one file in the change map.
 * @interface Neighbours
 * @typedef {Object} Neighbours
 * @property {string[]} imports — Targets of every edge from the file.
 * @property {string[]} importedBy — Files that import the file.
 * @property {string[]} testedBy — Files that test the file, by import or by name.
 */

/**
 * What `renderMap` needs besides the graph.
 * @interface MapOptions
 * @typedef {Object} MapOptions
 * @property {string|null} selected — Id of the selected node, null for none.
 * @property {Map<string, number>} counts — Open comments per file path.
 * @property {(id: string) => void} onSelect — Called with a node id on a click, Enter or Space.
 * @property {(id: string) => void} onOpen — Called with a node id on a double click.
 */

/**
 * One node position in SVG units.
 * @interface MapPoint
 * @typedef {Object} MapPoint
 * @property {number} x — Left edge of the node box.
 * @property {number} y — Top edge of the node box.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_W = 180;
const NODE_H = 52;
const COL_GAP = 60;
const ROW_GAP = 16;
const PAD = 16;
const GRID_COLS = 4;
const LABEL_MAX = 24;
const SAME_COLUMN_BULGE = 30;

const OPEN_STATUSES = new Set(['open', 'sent', 'answered']);

/**
 * @param {Iterable<string>} values
 * @returns {string[]}
 */
const sortedUnique = (values) => [...new Set(values)].sort();

/**
 * @param {IChangeGraph} graph
 * @param {string} id
 * @returns {Neighbours}
 */
export const neighbours = (graph, id) => ({
  imports: sortedUnique(graph.edges.filter((edge) => edge.from === id).map((edge) => edge.to)),
  importedBy: sortedUnique(graph.edges.filter((edge) => edge.to === id && edge.kind === 'import').map((edge) => edge.from)),
  testedBy: sortedUnique(graph.edges.filter((edge) => edge.to === id && edge.kind !== 'import').map((edge) => edge.from)),
});

/**
 * @param {Comment[]} comments
 * @returns {Map<string, number>}
 */
export const openCounts = (comments) => {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const comment of comments) {
    if (comment.file === null || !OPEN_STATUSES.has(comment.status)) continue;
    counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1);
  }
  return counts;
};

/**
 * @param {IChangeNode} node
 * @returns {string}
 */
const nodeLabel = (node) => {
  if (node.members) {
    return node.id.length > LABEL_MAX ? `…${node.id.slice(-(LABEL_MAX - 1))}` : node.id;
  }
  const base = node.id.slice(node.id.lastIndexOf('/') + 1);
  return base.length > LABEL_MAX ? `${base.slice(0, LABEL_MAX - 1)}…` : base;
};

/**
 * @param {IChangeNode} node
 * @param {Map<string, number>} counts
 * @returns {number}
 */
const nodeCount = (node, counts) => (node.members ?? [node.id])
  .reduce((sum, path) => sum + (counts.get(path) ?? 0), 0);

/**
 * @param {IChangeGraph} graph
 * @returns {Map<string, MapPoint>}
 */
const layout = (graph) => {
  /** @type {Map<string, MapPoint>} */
  const points = new Map();
  graph.nodes.forEach((node, index) => {
    const column = graph.meta.typescript ? node.layer : index % GRID_COLS;
    const row = graph.meta.typescript ? node.row : Math.floor(index / GRID_COLS);
    points.set(node.id, { x: PAD + column * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP) });
  });
  return points;
};

/**
 * @param {MapPoint} from
 * @param {MapPoint} to
 * @returns {string}
 */
const edgePath = (from, to) => {
  const fromY = from.y + NODE_H / 2;
  const toY = to.y + NODE_H / 2;
  if (from.x === to.x) {
    const x = from.x + NODE_W;
    return `M${x},${fromY} C${x + SAME_COLUMN_BULGE},${fromY} ${x + SAME_COLUMN_BULGE},${toY} ${x},${toY}`;
  }
  const rightward = to.x > from.x;
  const startX = rightward ? from.x + NODE_W : from.x;
  const endX = rightward ? to.x : to.x + NODE_W;
  const bend = (endX - startX) / 2;
  return `M${startX},${fromY} C${startX + bend},${fromY} ${endX - bend},${toY} ${endX},${toY}`;
};

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string|number>} attrs
 * @param {string} [text]
 * @returns {SVGElement}
 */
const svgEl = (doc, tag, attrs, text) => {
  const element = /** @type {SVGElement} */ (doc.createElementNS(SVG_NS, tag));
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
};

/**
 * @param {Document} doc
 * @param {IChangeNode} node
 * @param {MapPoint} point
 * @param {MapOptions} opts
 * @returns {SVGElement}
 */
const drawNode = (doc, node, point, opts) => {
  const classes = ['node', `kind-${node.kind}`, ...(node.id === opts.selected ? ['selected'] : [])];
  const group = svgEl(doc, 'g', {
    class: classes.join(' '),
    'data-id': node.id,
    tabindex: 0,
    role: 'button',
    'aria-label': node.id,
    transform: `translate(${point.x},${point.y})`,
  });
  group.append(
    svgEl(doc, 'title', {}, node.id),
    svgEl(doc, 'rect', { class: 'box', width: NODE_W, height: NODE_H, rx: 6 }),
    svgEl(doc, 'rect', { class: 'band', width: 6, height: NODE_H, rx: 2 }),
    svgEl(doc, 'text', { class: 'name', x: 16, y: 21 }, nodeLabel(node)),
    svgEl(doc, 'text', { class: 'stat', x: 16, y: 40 }, `+${node.added} -${node.removed}`),
  );
  if (node.isNew) group.append(svgEl(doc, 'text', { class: 'tag', x: NODE_W - 10, y: 21, 'text-anchor': 'end' }, 'new'));
  const count = nodeCount(node, opts.counts);
  if (count > 0) group.append(svgEl(doc, 'text', { class: 'count', x: NODE_W - 10, y: 40, 'text-anchor': 'end' }, String(count)));

  group.addEventListener('click', () => opts.onSelect(node.id));
  group.addEventListener('dblclick', () => opts.onOpen(node.id));
  group.addEventListener('keydown', (event) => {
    const { key } = /** @type {KeyboardEvent} */ (event);
    if (key !== 'Enter' && key !== ' ') return;
    event.preventDefault();
    opts.onSelect(node.id);
  });
  return group;
};

/**
 * @param {Document} doc
 * @param {IChangeGraph} graph
 * @param {MapOptions} opts
 * @returns {SVGSVGElement}
 */
export const renderMap = (doc, graph, opts) => {
  const points = layout(graph);
  const all = [...points.values()];
  const width = Math.max(0, ...all.map((point) => point.x + NODE_W)) + PAD + SAME_COLUMN_BULGE;
  const height = Math.max(0, ...all.map((point) => point.y + NODE_H)) + PAD;

  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (svgEl(doc, 'svg', {
    viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': 'Change map',
  })));

  const marker = svgEl(doc, 'marker', {
    id: 'map-arrow', viewBox: '0 0 8 8', refX: 8, refY: 4, markerWidth: 8, markerHeight: 8, orient: 'auto',
  });
  marker.append(svgEl(doc, 'path', { class: 'arrow', d: 'M0,0 L8,4 L0,8 z' }));
  const defs = svgEl(doc, 'defs', {});
  defs.append(marker);

  const edges = svgEl(doc, 'g', { class: 'edges' });
  for (const edge of graph.edges) {
    const from = points.get(edge.from);
    const to = points.get(edge.to);
    if (!from || !to) continue;
    const classes = ['edge', `edge-${edge.kind}`, ...(edge.cycle ? ['cycle'] : [])];
    edges.append(svgEl(doc, 'path', { class: classes.join(' '), d: edgePath(from, to), 'marker-end': 'url(#map-arrow)' }));
  }

  const nodes = svgEl(doc, 'g', { class: 'nodes' });
  for (const node of graph.nodes) {
    const point = points.get(node.id);
    if (point) nodes.append(drawNode(doc, node, point, opts));
  }

  svg.append(defs, edges, nodes);
  return svg;
};
