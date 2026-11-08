import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDownFromLine,
  ArrowRightFromLine,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileImage,
  ListCollapse,
  ListTree,
  LoaderCircle,
  Maximize,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { pickChartPath, saveChartImage } from "../../lib/chart";
import { fileBase } from "../../lib/exporting";
import { formatCount } from "../../lib/format";
import {
  DEFAULT_BUILD,
  buildRecordGraph,
  buildShapeGraph,
  collapsedBelow,
  graphSvg,
  index,
  jsonShape,
  layoutGraph,
  recordValue,
  search,
  type GraphColors,
  type GraphNode,
  type JsonShape,
  type JsonValue,
  type Line,
  type Orient,
} from "../../lib/jsonGraph";
import { statsSpec, type ViewSpec } from "../../lib/view";
import { useAppliedTheme } from "../../stores/appliedTheme";
import { useNotice } from "../../stores/notice";
import type { RowSource } from "../grid/rowSource";
import { Button, IconButton } from "../ui/Button";
import { MenuItem } from "../ui/Menu";
import { GraphCanvas, type GraphCanvasHandle } from "./GraphCanvas";

const NO_SHOWN: Record<string, number> = {};

/** Depth past which branches start collapsed. */
const OPEN_DEPTH = 2;

interface JsonGraphPanelProps {
  tabId: string;
  title: string;
  /** The rows the grid shows (the view), for the record graph. */
  source: RowSource;
  /** The full data, for the structure graph (under the view's filters). */
  datasetId?: string;
  view: ViewSpec;
  /** The record to show first (the grid's selected row). */
  record: number;
  onRecordChange?: (row: number) => void;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Width of one character of the cards' monospace font, in px. */
function measureCharWidth(): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 6.6;
  ctx.font = `11px ${cssVar("--font-data", "monospace")}`;
  const w = ctx.measureText("0".repeat(100)).width / 100;
  return w > 0 ? w : 6.6;
}

function graphColors(): GraphColors {
  return {
    bg: cssVar("--surface", "#f8f8f9"),
    card: cssVar("--bg", "#ffffff"),
    border: cssVar("--border-strong", "#d4d4da"),
    accent: cssVar("--accent", "#4f46e5"),
    fg: cssVar("--fg", "#18181b"),
    muted: cssVar("--fg-subtle", "#65656e"),
    string: cssVar("--syntax-string", "#047454"),
    number: cssVar("--syntax-number", "#a54c09"),
    keyword: cssVar("--syntax-keyword", "#6d28d9"),
    key: cssVar("--syntax-name", "#1d4ed8"),
    font: cssVar("--font-data", "monospace"),
  };
}

/** A value for the details, pretty and capped. */
function pretty(v: JsonValue | undefined): string {
  const text = JSON.stringify(v, null, 2) ?? "";
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text;
}

/** The value at a JSON path under `root` (paths as the graph writes them). */
function valueAt(root: JsonValue, path: string): JsonValue | undefined {
  const parts = [
    ...path.slice(1).matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g),
  ];
  let v: JsonValue | undefined = root;
  for (const m of parts) {
    if (v === null || typeof v !== "object") return undefined;
    const key: string | number =
      m[1] ?? (m[2] !== undefined ? Number(m[2]) : (JSON.parse(m[3]!) as string));
    v = Array.isArray(v) ? v[key as number] : (v as Record<string, JsonValue>)[key as string];
  }
  return v;
}

/**
 * Graph view of a JSON-like file: one record as connected cards, or the
 * structure of every record. Big records are paged and capped; the
 * structure comes from the engine, so file size doesn't matter.
 */
export function JsonGraphPanel({
  tabId,
  title,
  source,
  datasetId,
  view,
  record,
  onRecordChange,
}: JsonGraphPanelProps) {
  const notice = useNotice((s) => s.show);
  const themeVersion = useAppliedTheme((s) => s.version);
  const canvas = useRef<GraphCanvasHandle>(null);
  const [mode, setMode] = useState<"record" | "structure">("record");
  const [row, setRow] = useState(Math.min(Math.max(0, record), Math.max(0, source.rowCount - 1)));
  const [rowText, setRowText] = useState(String(row + 1));
  const [orient, setOrient] = useState<Orient>("LR");
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [charW, setCharW] = useState(6.6);

  useEffect(() => {
    let alive = true;
    void (document.fonts?.ready ?? Promise.resolve()).then(
      () => alive && setCharW(measureCharWidth()),
    );
    return () => {
      alive = false;
    };
  }, [themeVersion]);

  // What is wanted now, and what has arrived (loading = they differ).
  const statsKey = JSON.stringify(statsSpec(view));
  const want = mode === "record" ? `record:${row}` : `structure:${statsKey}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    value?: Record<string, JsonValue>;
    shape?: JsonShape;
    error?: string;
  } | null>(null);

  // The record: one row of the view, read from the grid's pages.
  useEffect(() => {
    if (mode !== "record" || source.rowCount === 0) return;
    let alive = true;
    const key = `record:${row}`;
    source.load(row, row + 1).then(
      () => {
        if (!alive) return;
        const values = source.columns.map((_, c) => source.getValue(row, c));
        setLoaded({ key, value: recordValue(source.columns, values) });
      },
      (e: unknown) =>
        alive && setLoaded({ key, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [mode, row, source]);

  // The structure: every record, under the view's filters and search.
  useEffect(() => {
    if (mode !== "structure" || !datasetId) return;
    let alive = true;
    const key = `structure:${statsKey}`;
    jsonShape(datasetId, JSON.parse(statsKey) as ViewSpec, `shape:${tabId}`).then(
      (shape) => alive && setLoaded({ key, shape }),
      (e: unknown) => {
        if (alive && (e as { kind?: string }).kind !== "cancelled")
          setLoaded({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [mode, datasetId, statsKey, tabId]);

  const current = loaded?.key === want ? loaded : null;
  const loading = current === null && (mode === "structure" ? !!datasetId : source.rowCount > 0);
  const value = current?.value ?? null;
  const error = current?.error ?? null;

  // Paging, collapsing and the selection belong to one record (or structure):
  // kept with its key, so a new one starts fresh.
  const [shownState, setShownState] = useState<{ key: string; map: Record<string, number> }>({
    key: "",
    map: {},
  });
  const shown = shownState.key === want ? shownState.map : NO_SHOWN;

  const graph = useMemo((): { root: GraphNode; truncated: boolean } | null => {
    if (current?.value) {
      const g = buildRecordGraph(current.value, `Record ${formatCount(row + 1)}`, {
        ...DEFAULT_BUILD,
        shown,
      });
      return { root: g.root, truncated: g.truncated };
    }
    if (current?.shape)
      return {
        root: buildShapeGraph(current.shape, `${formatCount(current.shape.rows)} records`),
        truncated: false,
      };
    return null;
  }, [current, shown, row]);

  const [collapsedState, setCollapsedState] = useState<{ key: string; set: Set<string> }>({
    key: "",
    set: new Set(),
  });
  const collapsed = useMemo(
    () =>
      collapsedState.key === want || !graph
        ? collapsedState.set
        : collapsedBelow(graph.root, OPEN_DEPTH),
    [collapsedState, want, graph],
  );
  const setCollapsed = (f: (c: Set<string>) => Set<string>) =>
    setCollapsedState({ key: want, set: f(collapsed) });
  const [selectedState, setSelectedState] = useState<{
    key: string;
    sel: { id: string; line?: Line } | null;
  }>({ key: "", sel: null });
  const selected = selectedState.key === want ? selectedState.sel : null;
  const setSelected = (sel: { id: string; line?: Line } | null) =>
    setSelectedState({ key: want, sel });

  const found = useMemo(
    () =>
      graph ? search(graph.root, query) : { matches: new Set<string>(), open: new Set<string>() },
    [graph, query],
  );
  /** A new search opens the branches that lead to its matches. */
  const runSearch = (q: string) => {
    setQuery(q);
    setHit(0);
    if (!graph) return;
    const { open } = search(graph.root, q);
    if (open.size > 0) setCollapsed((c) => new Set([...c].filter((id) => !open.has(id))));
  };
  const rootKey = graph ? want : "";
  const layout = useMemo(
    () => (graph ? layoutGraph(graph.root, collapsed, orient, charW) : null),
    [graph, collapsed, orient, charW],
  );
  const fitted = useRef("");
  useEffect(() => {
    const key = `${rootKey}:${orient}`;
    if (layout && fitted.current !== key) {
      fitted.current = key;
      requestAnimationFrame(() => canvas.current?.fit());
    }
  }, [layout, rootKey, orient]);

  const matchList = useMemo(() => [...found.matches], [found]);
  const goToHit = (i: number) => {
    if (matchList.length === 0) return;
    const n = (i + matchList.length) % matchList.length;
    setHit(n);
    setSelected({ id: matchList[n]! });
    canvas.current?.centre(matchList[n]!);
  };

  const go = (r: number) => {
    const next = Math.min(Math.max(0, r), source.rowCount - 1);
    setRow(next);
    setRowText(String(next + 1));
    onRecordChange?.(next);
  };

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const all = graph ? index(graph.root) : null;
  const detailNode = selected && all?.byId.get(selected.id);
  const detailValue =
    mode === "record" && selected && value ? valueAt(value as JsonValue, selected.id) : undefined;

  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(
      () => notice(`Copied ${what}`),
      (e: unknown) => notice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`),
    );

  const exportAs = async (ext: "png" | "svg") => {
    if (!layout) return;
    const svg = graphSvg(layout, graphColors());
    try {
      const path = await pickChartPath(`${fileBase(title, "graph")}-graph.${ext}`, ext);
      if (!path) return;
      let data = svg;
      if (ext === "png") {
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await img.decode();
        const scale = Math.min(2, 16000 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        data = c.toDataURL("image/png");
      }
      await saveChartImage(path, data);
      notice(`Saved the graph as ${ext.toUpperCase()}`);
    } catch (e) {
      notice(`Couldn't save the graph: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const seg = (on: boolean) =>
    `flex h-5 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[12px] ${
      on ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg"
    }`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" role="region" aria-label="Graph view">
      <div
        role="toolbar"
        aria-label="Graph options"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]"
      >
        <div
          role="radiogroup"
          aria-label="Graph of"
          className="flex items-center rounded-[var(--radius)] border border-border p-0.5"
        >
          {(
            [
              ["record", "Record"],
              ["structure", "Structure"],
            ] as const
          ).map(([m, name]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={m === "structure" && !datasetId}
              title={
                m === "structure" && !datasetId
                  ? "Available once the file is read"
                  : m === "structure"
                    ? "Every key of every record: types, how often, array lengths"
                    : "One record as connected cards"
              }
              onClick={() => setMode(m)}
              className={seg(mode === m)}
            >
              {name}
            </button>
          ))}
        </div>
        {mode === "record" && (
          <div className="flex items-center gap-1 text-fg-muted">
            <IconButton
              label="Previous record"
              className="size-6"
              disabled={row === 0}
              onClick={() => go(row - 1)}
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </IconButton>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(rowText.replace(/[,_\s]/g, ""));
                if (Number.isInteger(n) && n >= 1) go(n - 1);
              }}
            >
              <input
                aria-label="Record number"
                inputMode="numeric"
                className="tabular h-6 w-20 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-right text-fg outline-none focus:border-accent"
                value={rowText}
                onChange={(e) => setRowText(e.target.value)}
                onBlur={() => setRowText(String(row + 1))}
              />
            </form>
            <span className="tabular whitespace-nowrap">of {formatCount(source.rowCount)}</span>
            <IconButton
              label="Next record"
              className="size-6"
              disabled={row >= source.rowCount - 1}
              onClick={() => go(row + 1)}
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </IconButton>
          </div>
        )}
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Find in the graph"
            placeholder="Find keys or values"
            value={query}
            onChange={(e) => runSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goToHit(e.shiftKey ? hit - 1 : hit + (selected?.id === matchList[hit] ? 1 : 0));
              }
            }}
            className="h-6 w-52 rounded-[var(--radius)] border border-border bg-bg pr-2 pl-5 text-fg outline-none focus:border-accent"
          />
        </div>
        {query.trim() && (
          <span className="tabular text-fg-subtle" aria-live="polite">
            {matchList.length === 0
              ? "No matches"
              : `${hit + 1} of ${matchList.length} (Enter for the next)`}
          </span>
        )}
        <span className="flex-1" />
        {loading && (
          <LoaderCircle className="size-3.5 animate-spin text-fg-subtle" aria-label="Loading" />
        )}
        <IconButton
          label="Expand everything"
          className="size-6"
          onClick={() => setCollapsed(() => new Set())}
        >
          <ListTree className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton
          label="Collapse to the first levels"
          className="size-6"
          onClick={() => graph && setCollapsed(() => collapsedBelow(graph.root, 1))}
        >
          <ListCollapse className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton
          label={orient === "LR" ? "Lay out top to bottom" : "Lay out left to right"}
          className="size-6"
          onClick={() => setOrient(orient === "LR" ? "TB" : "LR")}
        >
          {orient === "LR" ? (
            <ArrowDownFromLine className="size-3.5" aria-hidden />
          ) : (
            <ArrowRightFromLine className="size-3.5" aria-hidden />
          )}
        </IconButton>
        <IconButton
          label="Zoom out"
          className="size-6"
          onClick={() => canvas.current?.zoomBy(1 / 1.25)}
        >
          <ZoomOut className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton label="Zoom in" className="size-6" onClick={() => canvas.current?.zoomBy(1.25)}>
          <ZoomIn className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton label="Fit the graph" className="size-6" onClick={() => canvas.current?.fit()}>
          <Maximize className="size-3.5" aria-hidden />
        </IconButton>
        <ExportMenu onExport={(ext) => void exportAs(ext)} disabled={!layout} />
        {mode === "record" && value && (
          <IconButton
            label="Copy the record as JSON"
            className="size-6"
            onClick={() => copy(JSON.stringify(value, null, 2), "the record as JSON")}
          >
            <Copy className="size-3.5" aria-hidden />
          </IconButton>
        )}
      </div>
      {graph?.truncated && (
        <p className="shrink-0 border-b border-border px-3 py-1 text-[12px] text-fg-muted">
          This record is very large: the first {formatCount(DEFAULT_BUILD.maxNodes)} cards are
          shown; the rest are listed on their parents’ cards.
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        {error ? (
          <p role="alert" className="m-4 text-fg-muted">
            Couldn’t draw the graph: {error}
          </p>
        ) : layout ? (
          <GraphCanvas
            ref={canvas}
            layout={layout}
            label={
              mode === "record" ? `Graph of record ${row + 1}` : "Graph of the file's structure"
            }
            selected={selected?.id ?? null}
            matches={found.matches}
            onSelect={(id, line) => setSelected({ id, line })}
            onToggle={toggle}
            onMore={(arrayId) =>
              setShownState({
                key: want,
                map: { ...shown, [arrayId]: (shown[arrayId] ?? 0) + DEFAULT_BUILD.pageSize },
              })
            }
          />
        ) : (
          <p className="m-4 text-fg-subtle">
            {source.rowCount === 0 ? "No records in the view." : "Loading…"}
          </p>
        )}
        {selected && (
          <aside
            aria-label="Details"
            className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border bg-bg p-3 text-[12px]"
          >
            <div className="flex items-center gap-1">
              <span className="text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
                {selected.line ? "Value" : detailNode?.kind === "array" ? "Array" : "Object"}
              </span>
              <span className="flex-1" />
              <IconButton
                label="Close details"
                className="size-5"
                onClick={() => setSelected(null)}
              >
                <span aria-hidden>×</span>
              </IconButton>
            </div>
            <div className="flex items-start gap-1">
              <code className="min-w-0 flex-1 font-mono break-all text-fg">{selected.id}</code>
              <IconButton
                label="Copy the JSON path"
                className="size-5 shrink-0"
                onClick={() => copy(selected.id, "the JSON path")}
              >
                <Copy className="size-3" aria-hidden />
              </IconButton>
            </div>
            {mode === "structure" && (selected.line ? null : detailNode?.sql) && (
              <div className="flex flex-col gap-1">
                <span className="text-fg-subtle">In SQL</span>
                <div className="flex items-start gap-1">
                  <code className="min-w-0 flex-1 font-mono break-all text-fg">
                    {detailNode!.sql}
                  </code>
                  <IconButton
                    label="Copy the SQL"
                    className="size-5 shrink-0"
                    onClick={() => copy(detailNode!.sql!, "the SQL")}
                  >
                    <Copy className="size-3" aria-hidden />
                  </IconButton>
                </div>
              </div>
            )}
            {selected.line && mode === "structure" && (
              <p className="text-fg">{selected.line.text}</p>
            )}
            {detailNode?.subtitle && !selected.line && (
              <p className="text-fg-muted">{detailNode.subtitle}</p>
            )}
            {mode === "record" && detailValue !== undefined && (
              <>
                <pre className="max-h-[50vh] overflow-auto rounded-[var(--radius)] bg-surface p-2 font-mono text-[11px] whitespace-pre-wrap text-fg">
                  {pretty(detailValue)}
                </pre>
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() =>
                    copy(
                      typeof detailValue === "string"
                        ? detailValue
                        : JSON.stringify(detailValue, null, 2),
                      "the value",
                    )
                  }
                >
                  <Copy className="size-3" aria-hidden /> Copy value
                </Button>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function ExportMenu({
  onExport,
  disabled,
}: {
  onExport: (ext: "png" | "svg") => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton label="Export the graph" className="size-6" disabled={disabled}>
          <Download className="size-3.5" aria-hidden />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          role="menu"
          aria-label="Export the graph"
          className="z-50 min-w-44 rounded-[var(--radius-lg)] border border-border bg-bg p-1 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          {(["png", "svg"] as const).map((ext, i) => (
            <MenuItem
              key={ext}
              icon={<FileImage />}
              autoFocus={i === 0}
              onSelect={() => {
                setOpen(false);
                onExport(ext);
              }}
            >
              Save as {ext.toUpperCase()}…
            </MenuItem>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
