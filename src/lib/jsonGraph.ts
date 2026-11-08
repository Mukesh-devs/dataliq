import type { ColumnInfo } from "./arrow";
import { formatValue, toJsonText } from "./format";
import { call } from "./ipc";
import type { ViewSpec } from "./view";

/**
 * The graph view of JSON-like files: a record (or the whole file's
 * structure) as cards joined by lines. An object's card lists its plain
 * values; nested objects and arrays branch off as cards of their own. The
 * layout is computed here (cards sized by their text in a monospace font),
 * so cards never overlap, and the same layout draws the screen and the SVG.
 */

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type LineKind = "string" | "number" | "boolean" | "null" | "type" | "empty";

/** A plain value on a card: `key: value`. */
export interface Line {
  key: string;
  text: string;
  kind: LineKind;
  /** The value's JSON path (for the details). */
  path: string;
}

export interface GraphNode {
  /** Its JSON path; unique in a graph. */
  id: string;
  title: string;
  /** "3 items", "5 keys", "in 67% of records", … */
  subtitle?: string;
  kind: "object" | "array" | "more";
  lines: Line[];
  children: GraphNode[];
  /** "more" nodes: items not shown, and the array that can show more. */
  hidden?: number;
  arrayId?: string;
  /** The value it stands for (record graph), for the details. */
  value?: JsonValue;
  /** Structure graph: SQL that reads the key. */
  sql?: string;
}

export interface BuildOptions {
  /** Items of an array shown at first, and added by its "more" node. */
  pageSize: number;
  /** Items shown per array id, past the first page. */
  shown: Record<string, number>;
  /** Cards at most (huge records stop with a "more" card). */
  maxNodes: number;
}

export const DEFAULT_BUILD: BuildOptions = { pageSize: 50, shown: {}, maxNodes: 1500 };

/** Characters of a value shown on a card (the details show all). */
export const MAX_TEXT = 48;
/** Plain values listed on one card; the rest are counted. */
export const MAX_LINES = 14;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `$.user.name`, `$["first name"]`, `$.items[2]`. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function short(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A plain value as card text and its kind. */
function plain(v: JsonValue): { text: string; kind: LineKind } {
  if (v === null) return { text: "null", kind: "null" };
  if (typeof v === "string") return { text: JSON.stringify(short(v)), kind: "string" };
  if (typeof v === "number") return { text: String(v), kind: "number" };
  if (typeof v === "boolean") return { text: String(v), kind: "boolean" };
  if (Array.isArray(v)) return { text: "[]", kind: "empty" };
  return { text: "{}", kind: "empty" };
}

/** Objects and arrays with something in them get a card of their own. */
const branches = (v: JsonValue): boolean =>
  v !== null &&
  typeof v === "object" &&
  (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);

const plural = (n: number, word: string) =>
  `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** The graph of one JSON value (a record), its arrays paged and its size capped. */
export function buildRecordGraph(
  value: JsonValue,
  title = "$",
  opts: BuildOptions = DEFAULT_BUILD,
): { root: GraphNode; nodes: number; truncated: boolean } {
  let nodes = 0;
  let truncated = false;
  const make = (v: JsonValue, id: string, name: string): GraphNode => {
    nodes++;
    const node: GraphNode = {
      id,
      title: name,
      kind: Array.isArray(v) ? "array" : "object",
      lines: [],
      children: [],
      value: v,
    };
    const entries: [string | number, JsonValue][] = Array.isArray(v)
      ? v.map((x, i) => [i, x])
      : Object.entries(v as Record<string, JsonValue>);
    let limit = entries.length;
    if (Array.isArray(v)) {
      node.subtitle = plural(v.length, "item");
      limit = Math.min(v.length, opts.pageSize + (opts.shown[id] ?? 0));
    } else {
      node.subtitle = plural(entries.length, "key");
    }
    for (const [key, x] of entries.slice(0, limit)) {
      const path = childPath(id, key);
      const label = typeof key === "number" ? `[${key}]` : key;
      if (!branches(x)) {
        node.lines.push({ key: label, path, ...plain(x) });
      } else if (nodes >= opts.maxNodes) {
        truncated = true;
        node.lines.push({
          key: label,
          path,
          text: Array.isArray(x) ? `[${x.length} items]` : "{…}",
          kind: "empty",
        });
      } else {
        node.children.push(make(x, path, label));
      }
    }
    if (limit < entries.length) {
      nodes++;
      node.children.push({
        id: `${id}…more`,
        title: `${(entries.length - limit).toLocaleString("en-US")} more`,
        subtitle: "Show more",
        kind: "more",
        lines: [],
        children: [],
        hidden: entries.length - limit,
        arrayId: id,
      });
    }
    return node;
  };
  const root = branches(value)
    ? make(value, "$", title)
    : {
        id: "$",
        title,
        kind: "object" as const,
        lines: [{ key: "value", path: "$", ...plain(value) }],
        children: [],
        value,
      };
  return { root, nodes: Math.max(nodes, 1), truncated };
}

/** A record of the grid as JSON: nested columns parsed, dates as text, big integers exact. */
export function recordValue(columns: ColumnInfo[], values: unknown[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  columns.forEach((c, i) => {
    const v = values[i];
    if (v === null || v === undefined) out[c.name] = null;
    else if (c.kind === "json") out[c.name] = JSON.parse(toJsonText(v)) as JsonValue;
    else if (c.kind === "integer" || c.kind === "number") {
      const text = formatValue(v, c) ?? "";
      const n = Number(text);
      out[c.name] =
        Number.isFinite(n) && (Number.isSafeInteger(n) || !/^-?\d+$/.test(text)) ? n : text;
    } else if (c.kind === "boolean") out[c.name] = v === true;
    else out[c.name] = formatValue(v, c);
  });
  return out;
}

/** The structure of a JSON-like file (from `json_shape`). */
export interface ShapeNode {
  name: string;
  kind: "object" | "array" | "value";
  type: string;
  present: number | null;
  avgLen: number | null;
  maxLen: number | null;
  sql: string | null;
  children: ShapeNode[];
}

export interface JsonShape {
  rows: number;
  fields: ShapeNode[];
  elapsedMs: number;
}

export function jsonShape(datasetId: string, spec: ViewSpec, group?: string): Promise<JsonShape> {
  return call("json_shape", { datasetId, spec, group });
}

function share(present: number | null, rows: number): string | undefined {
  if (present === null || rows === 0) return undefined;
  if (present === rows) return "in every record";
  const p = (present / rows) * 100;
  return `in ${p < 1 && p > 0 ? "<1" : Math.round(p)}% of records`;
}

/** The structure as a graph: object keys as lines (type · presence), objects and arrays as cards. */
export function buildShapeGraph(shape: JsonShape, title = "Every record"): GraphNode {
  const make = (n: ShapeNode, id: string): GraphNode => {
    const node: GraphNode = {
      id,
      title: n.name,
      kind: n.kind === "array" ? "array" : "object",
      subtitle:
        n.kind === "array"
          ? [
              n.type,
              n.avgLen !== null
                ? `avg ${Number(n.avgLen.toFixed(1)).toLocaleString("en-US")}, max ${(n.maxLen ?? 0).toLocaleString("en-US")} items`
                : undefined,
              share(n.present, shape.rows),
            ]
              .filter(Boolean)
              .join(" · ")
          : share(n.present, shape.rows),
      lines: [],
      children: [],
      sql: n.sql ?? undefined,
    };
    for (const c of n.children) {
      const path = n.kind === "array" ? `${id}[*]${childPath("", c.name)}` : childPath(id, c.name);
      if (c.kind === "value" || (c.kind === "object" && c.children.length === 0)) {
        const seen = share(c.present, shape.rows);
        node.lines.push({
          key: c.name,
          path,
          text:
            seen && seen !== "in every record" ? `${c.type} · ${seen.replace("in ", "")}` : c.type,
          kind: "type",
        });
      } else {
        node.children.push(make(c, path));
      }
    }
    return node;
  };
  return make(
    {
      name: title,
      kind: "object",
      type: "object",
      present: null,
      avgLen: null,
      maxLen: null,
      sql: null,
      children: shape.fields,
    },
    "$",
  );
}

/** Each node by id, and its parent's id. */
export function index(root: GraphNode): {
  byId: Map<string, GraphNode>;
  parent: Map<string, string>;
} {
  const byId = new Map<string, GraphNode>();
  const parent = new Map<string, string>();
  const walk = (n: GraphNode) => {
    byId.set(n.id, n);
    for (const c of n.children) {
      parent.set(c.id, n.id);
      walk(c);
    }
  };
  walk(root);
  return { byId, parent };
}

/** Ids of the nodes deeper than `depth` that have children (to start collapsed). */
export function collapsedBelow(root: GraphNode, depth: number): Set<string> {
  const out = new Set<string>();
  const walk = (n: GraphNode, d: number) => {
    if (d >= depth && n.children.length > 0) out.add(n.id);
    for (const c of n.children) walk(c, d + 1);
  };
  walk(root, 0);
  return out;
}

/** Nodes whose title, keys or values contain `query` (any case), and the ancestors to open. */
export function search(
  root: GraphNode,
  query: string,
): { matches: Set<string>; open: Set<string> } {
  const q = query.trim().toLowerCase();
  const matches = new Set<string>();
  const open = new Set<string>();
  if (!q) return { matches, open };
  const { parent } = index(root);
  const walk = (n: GraphNode) => {
    const hit =
      n.title.toLowerCase().includes(q) ||
      n.lines.some((l) => l.key.toLowerCase().includes(q) || l.text.toLowerCase().includes(q));
    if (hit) {
      matches.add(n.id);
      for (let p = parent.get(n.id); p !== undefined; p = parent.get(p)) open.add(p);
    }
    n.children.forEach(walk);
  };
  walk(root);
  return { matches, open };
}

// Card metrics (px): a monospace font, so text width is characters × width.
export const LINE_HEIGHT = 18;
export const PAD_X = 10;
export const PAD_Y = 8;
const MIN_W = 120;
const MAX_W = 440;
/** Gap between cards across the tree, and between depths. */
const GAP_ACROSS = 16;
const GAP_DEPTH = 56;

export type Orient = "LR" | "TB";

export interface PlacedNode {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  /** Lines shown on the card (the rest counted in `more`). */
  lines: Line[];
  more: number;
  /** Has children that are hidden. */
  collapsed: boolean;
}

export interface Edge {
  from: string;
  to: string;
  /** An SVG path from the parent's edge to the child's. */
  d: string;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: Edge[];
  width: number;
  height: number;
}

/** Card size for `node` given a character width. */
export function cardSize(
  node: GraphNode,
  charW: number,
): { w: number; h: number; lines: Line[]; more: number } {
  const lines = node.lines.slice(0, MAX_LINES);
  const more = node.lines.length - lines.length;
  // The title is bold (a little wider) and has a collapse arrow when it branches.
  const title =
    (node.title + (node.subtitle ? `  ${node.subtitle}` : "")).length * 1.1 +
    (node.children.length > 0 ? 3 : 0);
  const texts = [...lines.map((l) => `${l.key}: ${l.text}`), ...(more ? [`+ ${more} more`] : [])];
  const chars = Math.max(title, ...texts.map((t) => t.length));
  const w = Math.min(MAX_W, Math.max(MIN_W, Math.ceil(chars * charW * 1.05) + 2 * PAD_X + 2));
  const h = (1 + lines.length + (more ? 1 : 0)) * LINE_HEIGHT + 2 * PAD_Y;
  return { w, h, lines, more };
}

/**
 * Places the visible cards (collapsed ones hide their children): depths
 * side by side (LR) or stacked (TB), each subtree in a band as wide as its
 * cards, parents centred on their children.
 */
export function layoutGraph(
  root: GraphNode,
  collapsed: ReadonlySet<string>,
  orient: Orient = "LR",
  charW = 6.6,
): GraphLayout {
  const lr = orient === "LR";
  type Item = PlacedNode & { kids: Item[]; band: number };
  const depthSize: number[] = [];
  const build = (n: GraphNode, depth: number): Item => {
    const size = cardSize(n, charW);
    const closed = collapsed.has(n.id) && n.children.length > 0;
    const item: Item = {
      node: n,
      x: 0,
      y: 0,
      depth,
      collapsed: closed,
      ...size,
      kids: [],
      band: 0,
    };
    depthSize[depth] = Math.max(depthSize[depth] ?? 0, lr ? size.w : size.h);
    if (!closed) item.kids = n.children.map((c) => build(c, depth + 1));
    const across = lr ? size.h : size.w;
    const kidsBand =
      item.kids.reduce((s, k) => s + k.band, 0) + GAP_ACROSS * Math.max(0, item.kids.length - 1);
    item.band = Math.max(across, kidsBand);
    return item;
  };
  const top = build(root, 0);
  const depthStart: number[] = [];
  depthSize.reduce((at, size, d) => {
    depthStart[d] = at;
    return at + size + GAP_DEPTH;
  }, 0);
  const placed: PlacedNode[] = [];
  const edges: Edge[] = [];
  const place = (item: Item, start: number) => {
    const across = lr ? item.h : item.w;
    const kidsBand =
      item.kids.reduce((s, k) => s + k.band, 0) + GAP_ACROSS * Math.max(0, item.kids.length - 1);
    // Children centred in the band, the card centred on them.
    let at = start + (item.band - kidsBand) / 2;
    for (const k of item.kids) {
      place(k, at);
      at += k.band + GAP_ACROSS;
    }
    const centre = start + item.band / 2;
    if (lr) {
      item.x = depthStart[item.depth]!;
      item.y = centre - across / 2;
    } else {
      item.x = centre - across / 2;
      item.y = depthStart[item.depth]!;
    }
    for (const k of item.kids) {
      const [x1, y1, x2, y2] = lr
        ? [item.x + item.w, item.y + item.h / 2, k.x, k.y + k.h / 2]
        : [item.x + item.w / 2, item.y + item.h, k.x + k.w / 2, k.y];
      const m = lr ? (x1 + x2) / 2 : (y1 + y2) / 2;
      edges.push({
        from: item.node.id,
        to: k.node.id,
        d: lr
          ? `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`
          : `M${x1},${y1} C${x1},${m} ${x2},${m} ${x2},${y2}`,
      });
    }
    const { kids: _kids, band: _band, ...rest } = item;
    void _kids;
    void _band;
    placed.push(rest);
  };
  place(top, 0);
  const width = Math.max(...placed.map((p) => p.x + p.w));
  const height = Math.max(...placed.map((p) => p.y + p.h));
  return { nodes: placed, edges, width, height };
}

/** Colours the SVG export uses (the screen uses the same tokens through CSS). */
export interface GraphColors {
  bg: string;
  card: string;
  border: string;
  accent: string;
  fg: string;
  muted: string;
  string: string;
  number: string;
  keyword: string;
  key: string;
  font: string;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The layout as a standalone SVG document. */
export function graphSvg(layout: GraphLayout, c: GraphColors, margin = 16): string {
  const color = (k: LineKind) =>
    k === "string" ? c.string : k === "number" ? c.number : k === "type" ? c.muted : c.keyword;
  const parts: string[] = [];
  for (const e of layout.edges)
    parts.push(`<path d="${e.d}" fill="none" stroke="${c.border}" stroke-width="1.5"/>`);
  for (const p of layout.nodes) {
    parts.push(
      `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="6" fill="${c.card}" stroke="${p.node.kind === "more" ? c.accent : c.border}"/>`,
    );
    const tx = p.x + PAD_X;
    let ty = p.y + PAD_Y + LINE_HEIGHT * 0.72;
    parts.push(
      `<text x="${tx}" y="${ty}" font-weight="600" fill="${c.fg}">${escapeXml(p.node.title)}${
        p.node.subtitle
          ? `<tspan fill="${c.muted}" font-weight="400">  ${escapeXml(p.node.subtitle)}</tspan>`
          : ""
      }</text>`,
    );
    for (const l of p.lines) {
      ty += LINE_HEIGHT;
      parts.push(
        `<text x="${tx}" y="${ty}"><tspan fill="${c.key}">${escapeXml(l.key)}</tspan><tspan fill="${c.muted}">: </tspan><tspan fill="${color(l.kind)}">${escapeXml(l.text)}</tspan></text>`,
      );
    }
    if (p.more) {
      ty += LINE_HEIGHT;
      parts.push(`<text x="${tx}" y="${ty}" fill="${c.muted}">+ ${p.more} more</text>`);
    }
  }
  const w = layout.width + 2 * margin;
  const h = layout.height + 2 * margin;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${-margin} ${-margin} ${w} ${h}" font-family="${escapeXml(c.font)}" font-size="11">` +
    `<rect x="${-margin}" y="${-margin}" width="${w}" height="${h}" fill="${c.bg}"/>` +
    parts.join("") +
    `</svg>`
  );
}
