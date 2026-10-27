import * as Popover from "@radix-ui/react-popover";
import {
  ChartBar,
  Code,
  Download,
  FileImage,
  ChartColumn,
  ChartColumnBig,
  ChartLine,
  ChartScatter,
  CircleAlert,
  LoaderCircle,
  Plus,
  Table2,
  X,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { baseName } from "../../lib/files";
import { formatSql } from "../../lib/sqlFormat";
import { useRegisterCommands, type Command } from "../../stores/commands";
import { useNotice } from "../../stores/notice";
import { MenuItem } from "../ui/Menu";
import type { ColumnInfo } from "../../lib/arrow";
import {
  AGGS,
  BUCKETS,
  CHART_KINDS,
  MAX_MEASURES,
  allowed,
  chartColors,
  chartData,
  chartFileName,
  chartNote,
  chartSql,
  chartOption,
  chartTable,
  fitChart,
  isTimeKind,
  pickChartPath,
  saveChartImage,
  type Agg,
  type ChartData,
  type ChartKind,
  type ChartSpec,
} from "../../lib/chart";
import { formatDuration } from "../../lib/format";
import { statsSpec, type ViewSpec } from "../../lib/view";
import { useAppliedTheme } from "../../stores/appliedTheme";
import { IconButton } from "../ui/Button";
import { EChart, type EChartHandle } from "./EChart";

const KIND_ICONS: Record<ChartKind, typeof ChartBar> = {
  bar: ChartColumn,
  horizontalBar: ChartBar,
  line: ChartLine,
  histogram: ChartColumnBig,
  scatter: ChartScatter,
};

const selectClass =
  "h-7 min-w-0 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-[12px] text-fg outline-none focus:border-accent";

let nextRequest = 1;

export interface ChartPanelHandle {
  chart: () => EChartHandle | null;
  data: () => ChartData | null;
}

interface ChartPanelProps {
  tabId: string;
  /** The tab's full dataset (charts use the view's filters and search). */
  datasetId: string;
  view: ViewSpec;
  columns: ColumnInfo[];
  /** Display names. */
  labelOf: (column: string) => string;
  chart: ChartSpec;
  onChange: (chart: ChartSpec) => void;
  /** For file names. */
  title: string;
  /** The file's reader call, for "Copy chart SQL" (none: no copy). */
  readerSql?: string;
}

/** The current view as a chart, aggregated in DuckDB. */
export const ChartPanel = forwardRef<ChartPanelHandle, ChartPanelProps>(function ChartPanel(
  { tabId, datasetId, view, columns, labelOf, chart, onChange, title, readerSql },
  ref,
) {
  const notice = useNotice((s) => s.show);
  const [exportOpen, setExportOpen] = useState(false);
  const [state, setState] = useState<{
    key: string;
    data?: ChartData;
    error?: string;
  } | null>(null);
  const [table, setTable] = useState(false);
  const echart = useRef<EChartHandle>(null);
  const themeVersion = useAppliedTheme((s) => s.version);

  const statsKey = JSON.stringify(statsSpec(view));
  const key = `${datasetId}\u0000${statsKey}\u0000${JSON.stringify(chart)}`;
  useEffect(() => {
    let alive = true;
    const requestId = `chart-${nextRequest++}`;
    chartData(datasetId, JSON.parse(statsKey) as ViewSpec, chart, requestId, `chart:${tabId}`)
      .then((data) => alive && setState({ key, data }))
      .catch((e: unknown) => {
        if (!alive || (e as { kind?: string }).kind === "cancelled") return;
        setState({ key, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
    // `key` covers the dataset, the view's filters and the chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loading = state?.key !== key;
  // The previous chart stays up while the next one loads.
  const data = state?.data;
  const error = !loading ? state?.error : undefined;
  const colors = useMemo(
    () => chartColors(),
    // Read again once the new theme's tokens are applied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeVersion],
  );
  const option = useMemo(
    () =>
      data
        ? chartOption(data, chart, colors, {
            x: labelOf(chart.x),
            y: chart.y ? labelOf(chart.y) : undefined,
          })
        : null,
    [data, chart, colors, labelOf],
  );

  useImperativeHandle(ref, () => ({ chart: () => echart.current, data: () => data ?? null }), [
    data,
  ]);

  /** Copies the chart as SQL that runs in plain DuckDB over the file. */
  const copySql = async () => {
    if (!readerSql) return;
    try {
      const sql = await chartSql(datasetId, statsSpec(view), chart, readerSql);
      let text = sql;
      try {
        text = formatSql(sql);
      } catch {
        // Unformatted SQL runs just as well.
      }
      await navigator.clipboard.writeText(text);
      notice("Copied the chart as SQL");
    } catch (e) {
      notice(`Couldn't copy the chart: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  /** Saves the chart as it looks now, on the theme's background. */
  const exportImage = async (ext: "png" | "svg") => {
    setExportOpen(false);
    const handle = echart.current;
    const image = handle && (ext === "png" ? handle.png(colors.bg) : handle.svg(colors.bg));
    if (!image) {
      notice("Show the chart first, then export it");
      return;
    }
    try {
      const path = await pickChartPath(chartFileName(title, ext), ext);
      if (!path) return;
      await saveChartImage(path, image);
      notice(`Saved the chart to ${baseName(path)}`);
    } catch (e) {
      notice(`Couldn't save the chart: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const canExport = !!option && !table && !error;
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (canExport) {
      list.push(
        {
          id: "chart-png",
          title: "Export chart as PNG",
          group: "Chart",
          keywords: "image picture save",
          run: () => void exportImage("png"),
        },
        {
          id: "chart-svg",
          title: "Export chart as SVG",
          group: "Chart",
          keywords: "image vector save",
          run: () => void exportImage("svg"),
        },
      );
    }
    if (readerSql)
      list.push({
        id: "chart-sql",
        title: "Copy chart as SQL",
        group: "Chart",
        keywords: "query duckdb",
        run: () => void copySql(),
      });
    return list;
    // The actions read the latest chart when picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canExport, readerSql, chart, view, datasetId, colors, title]);
  useRegisterCommands("chart", commands);

  const ok = allowed(chart.kind, columns);
  const set = (changes: Partial<ChartSpec>) =>
    onChange(fitChart({ ...chart, ...changes }, columns));
  const xCol = columns.find((c) => c.name === chart.x);
  const grouped = chart.kind === "bar" || chart.kind === "horizontalBar" || chart.kind === "line";
  const measures = chart.measures ?? [{ agg: "count" as Agg }];
  const setMeasure = (i: number, agg: Agg, column?: string) => {
    const next = measures.map((m, j) =>
      j === i ? { agg, column: agg === "count" ? undefined : column } : m,
    );
    onChange(fitChart({ ...chart, measures: next }, columns));
  };
  const columnOptions = (list: ColumnInfo[]) =>
    list.map((c) => (
      <option key={c.name} value={c.name}>
        {labelOf(c.name)}
      </option>
    ));

  const summary = data
    ? `${CHART_KINDS.find((k) => k.kind === data.kind)?.label} of ${labelOf(chart.x)}`
    : "Chart";
  const tableData = table && data ? chartTable(data, chart.bucket) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Chart panel" role="region">
      <div
        role="toolbar"
        aria-label="Chart options"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]"
      >
        <div role="radiogroup" aria-label="Chart type" className="flex items-center gap-0.5">
          {CHART_KINDS.map(({ kind, label }) => {
            const Icon = KIND_ICONS[kind];
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={chart.kind === kind}
                aria-label={label}
                title={label}
                onClick={() => set({ kind })}
                className={`flex size-7 items-center justify-center rounded-[var(--radius)] ${
                  chart.kind === kind
                    ? "bg-accent-soft text-accent"
                    : "text-fg-muted hover:bg-hover hover:text-fg"
                }`}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-1 text-fg-muted">
          {chart.kind === "scatter" ? "X" : chart.kind === "histogram" ? "Column" : "Group by"}
          <select
            aria-label={chart.kind === "scatter" ? "X axis" : "Column"}
            className={selectClass}
            value={chart.x}
            onChange={(e) => set({ x: e.target.value })}
          >
            {columnOptions(ok.x)}
          </select>
        </label>
        {grouped && xCol && isTimeKind(xCol.kind) && (
          <label className="flex items-center gap-1 text-fg-muted">
            by
            <select
              aria-label="Date bucket"
              className={selectClass}
              value={chart.bucket ?? ""}
              onChange={(e) =>
                set({ bucket: (e.target.value || undefined) as ChartSpec["bucket"] })
              }
            >
              <option value="">Exact value</option>
              {BUCKETS.map((b) => (
                <option key={b.bucket} value={b.bucket}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {chart.kind === "scatter" && (
          <label className="flex items-center gap-1 text-fg-muted">
            Y
            <select
              aria-label="Y axis"
              className={selectClass}
              value={chart.y ?? ""}
              onChange={(e) => set({ y: e.target.value })}
            >
              {columnOptions(ok.y)}
            </select>
          </label>
        )}
        {chart.kind === "histogram" && (
          <label className="flex items-center gap-1 text-fg-muted">
            Bars
            <select
              aria-label="Bars"
              className={selectClass}
              value={chart.bins ?? 30}
              onChange={(e) => set({ bins: Number(e.target.value) })}
            >
              {[10, 20, 30, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {grouped && (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Measures">
            {measures.map((m, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-[var(--radius)] border border-border py-0.5 pr-0.5 pl-1"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-[2px]"
                  style={{ background: colors.series[i] }}
                />
                <select
                  aria-label={`Measure ${i + 1}`}
                  className="h-6 rounded-[var(--radius-sm)] bg-transparent text-[12px] text-fg outline-none"
                  value={m.agg}
                  onChange={(e) =>
                    setMeasure(
                      i,
                      e.target.value as Agg,
                      m.column ??
                        (e.target.value === "countDistinct" ? chart.x : ok.measureColumns[0]?.name),
                    )
                  }
                >
                  {AGGS.map((a) => (
                    <option
                      key={a.agg}
                      value={a.agg}
                      disabled={
                        a.agg !== "count" &&
                        a.agg !== "countDistinct" &&
                        ok.measureColumns.length === 0
                      }
                    >
                      {a.label}
                    </option>
                  ))}
                </select>
                {m.agg !== "count" && (
                  <select
                    aria-label={`Measure ${i + 1} column`}
                    className="h-6 max-w-40 rounded-[var(--radius-sm)] bg-transparent text-[12px] text-fg outline-none"
                    value={m.column ?? ""}
                    onChange={(e) => setMeasure(i, m.agg, e.target.value)}
                  >
                    {columnOptions(m.agg === "countDistinct" ? columns : ok.measureColumns)}
                  </select>
                )}
                {measures.length > 1 && (
                  <IconButton
                    label={`Remove measure ${i + 1}`}
                    className="size-5"
                    onClick={() =>
                      onChange({ ...chart, measures: measures.filter((_, j) => j !== i) })
                    }
                  >
                    <X className="size-3" aria-hidden />
                  </IconButton>
                )}
              </span>
            ))}
            {measures.length < MAX_MEASURES && (
              <IconButton
                label="Add measure"
                className="size-6"
                onClick={() =>
                  onChange({
                    ...chart,
                    measures: [
                      ...measures,
                      ok.measureColumns[0]
                        ? { agg: "sum", column: ok.measureColumns[0].name }
                        : { agg: "countDistinct", column: chart.x },
                    ],
                  })
                }
              >
                <Plus className="size-3.5" aria-hidden />
              </IconButton>
            )}
          </div>
        )}
        <span className="flex-1" />
        <span className="tabular text-fg-subtle" role="status" aria-label="Chart status">
          {loading && <LoaderCircle className="mr-1 inline size-3 animate-spin" aria-hidden />}
          {data && !error && `${chartNote(data)} · ${formatDuration(data.elapsedMs)}`}
        </span>
        {readerSql && (
          <IconButton label="Copy chart as SQL" onClick={() => void copySql()}>
            <Code className="size-3.5" aria-hidden />
          </IconButton>
        )}
        <Popover.Root open={exportOpen} onOpenChange={setExportOpen}>
          <Popover.Trigger asChild>
            <IconButton label="Export chart" disabled={!canExport} className="disabled:opacity-40">
              <Download className="size-3.5" aria-hidden />
            </IconButton>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              role="menu"
              aria-label="Export chart"
              align="end"
              sideOffset={4}
              className="z-50 w-44 rounded-[var(--radius-lg)] border border-border bg-bg p-1 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
            >
              <MenuItem autoFocus icon={<FileImage />} onSelect={() => void exportImage("png")}>
                PNG image
              </MenuItem>
              <MenuItem icon={<FileImage />} onSelect={() => void exportImage("svg")}>
                SVG image
              </MenuItem>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <IconButton
          label={table ? "Show the chart" : "Show the chart's values as a table"}
          aria-pressed={table}
          className={table ? "text-fg" : ""}
          onClick={() => setTable(!table)}
        >
          <Table2 className="size-3.5" aria-hidden />
        </IconButton>
      </div>
      {error ? (
        <div role="alert" className="flex items-start gap-2 p-4 text-[12px]">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          <span className="text-fg-muted">Couldn't draw the chart: {error}</span>
        </div>
      ) : tableData ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <table
            className="tabular w-auto border-collapse font-mono text-[12px]"
            aria-label="Chart values"
          >
            <thead>
              <tr>
                {tableData.head.map((h, i) => (
                  <th
                    key={i}
                    className={`border-b border-border px-3 py-1 font-medium text-fg ${i === 0 ? "text-left" : "text-right"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableData.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td
                      key={j}
                      className={`border-b border-border px-3 py-1 ${j === 0 ? "text-left text-fg" : "text-right text-fg-muted"}`}
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : option ? (
        <div className="relative min-h-0 flex-1 p-3">
          <EChart ref={echart} option={option} label={summary} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-fg-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Drawing the chart…
        </div>
      )}
    </div>
  );
});
