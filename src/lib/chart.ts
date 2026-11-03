import type { ColumnInfo, ColumnKind } from "./arrow";
import { fileBase } from "./exporting";
import { formatCount } from "./format";
import { call } from "./ipc";
import type { ViewSpec } from "./view";

export type ChartKind = "bar" | "horizontalBar" | "line" | "histogram" | "scatter" | "pie" | "box";
export type Agg = "count" | "sum" | "avg" | "min" | "max" | "countDistinct";
export type Bucket = "day" | "week" | "month" | "year";

export interface Measure {
  agg: Agg;
  column?: string;
}

export interface ChartSpec {
  kind: ChartKind;
  x: string;
  bucket?: Bucket;
  measures?: Measure[];
  /** Scatter: the y axis; box plot: the number column. */
  y?: string;
  /** Bar and line: a series per value of this column (the first measure). */
  splitBy?: string;
  /** Bars: series stacked rather than side by side. */
  stacked?: boolean;
  /** Pie: a ring. */
  donut?: boolean;
  bins?: number;
  limit?: number;
  sample?: number;
}

export interface Bin {
  lo: number;
  hi: number;
  count: number;
}

export interface ChartData {
  kind: ChartKind;
  xKind: "category" | "number" | "time";
  x: (string | number | null)[];
  series: { name: string; values: (number | null)[] }[];
  bins: Bin[];
  total: number;
  truncated: boolean;
  /** Pie of a count or sum: the slices not shown, together. */
  other?: number | null;
  elapsedMs: number;
}

/** Most series on one chart (the validated colour slots). */
export const MAX_MEASURES = 4;

export const CHART_KINDS: { kind: ChartKind; label: string }[] = [
  { kind: "bar", label: "Bar" },
  { kind: "horizontalBar", label: "Horizontal bar" },
  { kind: "line", label: "Line" },
  { kind: "histogram", label: "Histogram" },
  { kind: "scatter", label: "Scatter" },
  { kind: "pie", label: "Pie" },
  { kind: "box", label: "Box plot" },
];

/** Kinds grouped by a column with measures (bars, lines and pies). */
export const isGrouped = (k: ChartKind) =>
  k === "bar" || k === "horizontalBar" || k === "line" || k === "pie";
/** Kinds that can split into a series per value of a second column. */
export const canSplit = (k: ChartKind) => k === "bar" || k === "horizontalBar" || k === "line";

export const AGGS: { agg: Agg; label: string }[] = [
  { agg: "count", label: "Count" },
  { agg: "sum", label: "Sum" },
  { agg: "avg", label: "Average" },
  { agg: "min", label: "Min" },
  { agg: "max", label: "Max" },
  { agg: "countDistinct", label: "Distinct" },
];

export const BUCKETS: { bucket: Bucket; label: string }[] = [
  { bucket: "day", label: "Day" },
  { bucket: "week", label: "Week" },
  { bucket: "month", label: "Month" },
  { bucket: "year", label: "Year" },
];

export function chartData(
  datasetId: string,
  spec: ViewSpec,
  chart: ChartSpec,
  requestId: string,
  group: string,
): Promise<ChartData> {
  return call<ChartData>("chart_data", { datasetId, spec, chart, requestId, group });
}

/** The chart as standalone DuckDB SQL over `reader` (the file's reader call). */
export function chartSql(
  datasetId: string,
  spec: ViewSpec,
  chart: ChartSpec,
  reader: string,
): Promise<string> {
  return call<string>("chart_sql", { datasetId, spec, chart, reader });
}

/** Saves an exported chart: an SVG document or a PNG data URL. */
export function saveChartImage(path: string, data: string): Promise<void> {
  return call<void>("save_chart_image", { path, data });
}

/** "sales.csv.gz" → "sales-chart.png". */
export function chartFileName(title: string, ext: "png" | "svg"): string {
  return `${fileBase(title, "chart")}-chart.${ext}`;
}

/** The native save dialog for a chart image. Null when cancelled. */
export async function pickChartPath(name: string, ext: "png" | "svg"): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: name,
    filters: [{ name: ext === "png" ? "PNG image" : "SVG image", extensions: [ext] }],
  });
}

const NUMBER_KINDS = new Set<ColumnKind>(["integer", "number"]);
const TIME_KINDS = new Set<ColumnKind>(["date", "timestamp"]);

export const isNumberKind = (k: ColumnKind) => NUMBER_KINDS.has(k);
export const isTimeKind = (k: ColumnKind) => TIME_KINDS.has(k);
/** Columns a histogram or scatter axis can use. */
export const isAxisKind = (k: ColumnKind) => isNumberKind(k) || isTimeKind(k);

/** What the chart's options allow for `kind`, given the columns. */
export function allowed(kind: ChartKind, columns: ColumnInfo[]) {
  const axis = columns.filter((c) => isAxisKind(c.kind));
  const numbers = columns.filter((c) => isNumberKind(c.kind));
  return {
    x: kind === "histogram" || kind === "scatter" ? axis : columns,
    y: kind === "scatter" ? axis : kind === "box" ? numbers : [],
    measureColumns: numbers,
  };
}

/**
 * A first chart for a file: dates over time if there are any, else the
 * first text column's groups, else a histogram of the first number.
 */
export function defaultChart(columns: ColumnInfo[]): ChartSpec | null {
  const date = columns.find((c) => isTimeKind(c.kind));
  if (date) return { kind: "line", x: date.name, bucket: "month", measures: [{ agg: "count" }] };
  const text = columns.find((c) => c.kind === "text" || c.kind === "boolean");
  if (text) return { kind: "bar", x: text.name, measures: [{ agg: "count" }] };
  const num = columns.find((c) => isNumberKind(c.kind));
  if (num) return { kind: "histogram", x: num.name };
  return null;
}

/**
 * Keeps a chart valid after its type or the columns change: the x and y
 * axes fit the type, measures aggregate number columns (count needs none).
 */
export function fitChart(chart: ChartSpec, columns: ColumnInfo[]): ChartSpec {
  const ok = allowed(chart.kind, columns);
  const has = (list: ColumnInfo[], name?: string) => !!name && list.some((c) => c.name === name);
  const x = has(ok.x, chart.x) ? chart.x : (ok.x[0]?.name ?? chart.x);
  const next: ChartSpec = { ...chart, x };
  if (chart.kind === "scatter") {
    next.y = has(ok.y, chart.y) ? chart.y : (ok.y.find((c) => c.name !== x) ?? ok.y[0])?.name;
  }
  if (chart.kind === "box") {
    next.y = has(ok.y, chart.y) ? chart.y : (ok.y.find((c) => c.name !== x) ?? ok.y[0])?.name;
  }
  const xCol = columns.find((c) => c.name === x);
  if (!xCol || !isTimeKind(xCol.kind) || chart.kind === "box") delete next.bucket;
  // A split needs another existing column; it keeps one measure.
  const split =
    canSplit(chart.kind) && chart.splitBy && chart.splitBy !== x && has(columns, chart.splitBy);
  if (!split) delete next.splitBy;
  if (chart.kind !== "bar" && chart.kind !== "horizontalBar") delete next.stacked;
  if (chart.kind !== "pie") delete next.donut;
  if (isGrouped(chart.kind)) {
    const measures = (chart.measures ?? []).filter(
      (m) => m.agg === "count" || m.agg === "countDistinct" || has(ok.measureColumns, m.column),
    );
    const most = chart.kind === "pie" || split ? 1 : MAX_MEASURES;
    next.measures = measures.length > 0 ? measures.slice(0, most) : [{ agg: "count" }];
  } else {
    delete next.measures;
  }
  return next;
}

/** "Top 50 of 1,234 groups", "5,000 of 1,000,000 points (random sample)". */
export function chartNote(data: ChartData): string {
  if (data.kind === "histogram") return `${formatCount(data.total)} values`;
  if (data.kind === "scatter") {
    return data.truncated
      ? `${formatCount(data.x.length)} of ${formatCount(data.total)} points (random sample)`
      : `${formatCount(data.total)} points`;
  }
  if (data.xKind === "category") {
    return data.truncated
      ? `Top ${formatCount(data.x.length)} of ${formatCount(data.total)} groups`
      : `${formatCount(data.total)} groups`;
  }
  // An axis of numbers or dates has no place for rows without a value.
  const drawn = data.x.filter((v) => v != null).length;
  const empty =
    drawn < data.x.length ? ` · empty ${data.xKind === "time" ? "dates" : "values"} not drawn` : "";
  return data.truncated
    ? `First ${formatCount(drawn)} of ${formatCount(data.total)} points${empty}`
    : `${formatCount(drawn)} points${empty}`;
}

/** Colours and fonts read from the design tokens. */
export interface ChartColors {
  series: string[];
  fg: string;
  muted: string;
  subtle: string;
  border: string;
  surface: string;
  bg: string;
  font: string;
  mono: string;
}

export function chartColors(root: HTMLElement = document.documentElement): ChartColors {
  const s = getComputedStyle(root);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    series: [
      v("--series-1", "#2a78d6"),
      v("--series-2", "#eb6834"),
      v("--series-3", "#1baf7a"),
      v("--series-4", "#eda100"),
      v("--series-5", "#8f5bd9"),
      v("--series-6", "#d6458f"),
      v("--series-7", "#1497b8"),
      v("--series-8", "#7a8a1f"),
    ],
    fg: v("--fg", "#18181b"),
    muted: v("--fg-muted", "#52525b"),
    subtle: v("--fg-subtle", "#65656e"),
    border: v("--border", "#e6e6ea"),
    surface: v("--surface", "#f8f8f9"),
    bg: v("--bg", "#ffffff"),
    font: v("--font-ui", "sans-serif"),
    mono: v("--font-data", "monospace"),
  };
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** An axis tick: 1.2M, 950. */
export const formatTick = (v: number) =>
  Math.abs(v) >= 10_000 ? compact.format(v) : full.format(v);
export const formatNumber = (v: number | null) => (v == null ? "null" : full.format(v));

/** A time on the axis, as precise as the bucket. */
export function formatTime(ms: number, bucket?: Bucket): string {
  const d = new Date(ms);
  const iso = d.toISOString();
  if (bucket === "year") return iso.slice(0, 4);
  if (bucket === "month") return iso.slice(0, 7);
  if (bucket === "week") return `Week of ${iso.slice(0, 10)}`;
  if (bucket === "day" || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0)) {
    return iso.slice(0, 10);
  }
  return iso.slice(0, 19).replace("T", " ");
}

/** The label of x (or a bin edge) for tooltips and the table. */
export function formatX(data: ChartData, v: string | number | null, bucket?: Bucket): string {
  if (v == null) return "null";
  if (data.xKind === "time") return formatTime(Number(v), bucket);
  if (data.xKind === "number") return formatNumber(Number(v));
  return String(v);
}

/** Rows for the table view: the label, then one value per series. */
export function chartTable(data: ChartData, bucket?: Bucket): { head: string[]; rows: string[][] } {
  if (data.kind === "histogram") {
    return {
      head: ["From", "To", "Count"],
      rows: data.bins.map((b) => [formatX(data, b.lo), formatX(data, b.hi), formatCount(b.count)]),
    };
  }
  const rows = data.x.map((x, i) => [
    formatX(data, x, bucket),
    ...data.series.map((s) => formatNumber(s.values[i] ?? null)),
  ]);
  if (data.kind === "pie" && data.other) rows.push(["Other", formatNumber(data.other)]);
  return {
    head: [data.kind === "scatter" ? "x" : "Group", ...data.series.map((s) => s.name)],
    rows,
  };
}

type Option = Record<string, unknown>;

/**
 * The ECharts option for `data`. Thin bars (at most 24 px, 4 px rounded
 * ends), 2 px lines, a legend for two or more series, recessive grid and
 * axes, text in text colours, series colours in fixed order.
 */
export function chartOption(
  data: ChartData,
  chart: ChartSpec,
  c: ChartColors,
  labels: { x: string; y?: string } = { x: chart.x },
): Option {
  const text = { color: c.muted, fontFamily: c.font, fontSize: 11 };
  const axisLine = { lineStyle: { color: c.border } };
  const splitLine = { lineStyle: { color: c.border } };
  // Axis names under the x axis and above the y axis, where they aren't
  // clipped; bars and lines leave them out (the toolbar names the column).
  const valueAxis = (name?: string, time = false, vertical = false) => ({
    type: time ? "time" : "value",
    name,
    nameLocation: vertical ? "end" : "middle",
    nameGap: vertical ? 12 : 26,
    nameTextStyle: { ...text, align: vertical ? "left" : "center" },
    axisLabel: {
      ...text,
      formatter: time ? (v: number) => formatTime(v, chart.bucket) : (v: number) => formatTick(v),
      hideOverlap: true,
    },
    axisLine,
    splitLine,
    scale: !time && data.kind === "scatter",
  });
  const tooltip = {
    backgroundColor: c.bg,
    borderColor: c.border,
    textStyle: { color: c.fg, fontFamily: c.font, fontSize: 12 },
    extraCssText: "box-shadow: 0 4px 12px rgb(0 0 0 / 0.12); border-radius: 6px;",
  };
  const base: Option = {
    animationDuration: 120,
    textStyle: { fontFamily: c.font },
    color: c.series,
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
  };
  const multi = data.series.length > 1;
  const legend = multi
    ? { top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: text }
    : undefined;

  if (data.kind === "histogram") {
    const time = data.xKind === "time";
    return {
      ...base,
      tooltip: {
        ...tooltip,
        trigger: "item",
        formatter: (p: { dataIndex: number }) => {
          const b = data.bins[p.dataIndex]!;
          return `${formatX(data, b.lo)} – ${formatX(data, b.hi)}<br/><b>${formatCount(b.count)}</b> rows`;
        },
      },
      grid: { ...(base.grid as object), top: 28, bottom: 24 },
      xAxis: { ...valueAxis(labels.x, time), scale: true, splitLine: { show: false } },
      yAxis: valueAxis("Count", false, true),
      series: [
        {
          type: "custom",
          renderItem: (
            _: unknown,
            api: {
              value: (i: number) => number;
              coord: (v: [number, number]) => [number, number];
              style: (s: Record<string, unknown>) => Record<string, unknown>;
            },
          ) => {
            const [x0, y0] = api.coord([api.value(0), 0]);
            const [x1, y1] = api.coord([api.value(1), api.value(2)]);
            // A 2 px gap between neighbouring bars; rounded tops.
            return {
              type: "rect",
              shape: {
                x: x0 + 1,
                y: y1,
                width: Math.max(1, x1 - x0 - 2),
                height: y0 - y1,
                r: [4, 4, 0, 0],
              },
              style: api.style({ fill: c.series[0] }),
            };
          },
          encode: { x: [0, 1], y: 2 },
          data: data.bins.map((b) => [b.lo, b.hi, b.count]),
        },
      ],
    };
  }

  if (data.kind === "scatter") {
    const time = data.xKind === "time";
    return {
      ...base,
      tooltip: {
        ...tooltip,
        trigger: "item",
        formatter: (p: { value: [number, number] }) =>
          `${labels.x}: <b>${formatX(data, p.value[0])}</b><br/>${labels.y ?? ""}: <b>${formatNumber(p.value[1])}</b>`,
      },
      grid: { ...(base.grid as object), top: 28, bottom: 24 },
      xAxis: valueAxis(labels.x, time),
      yAxis: valueAxis(labels.y, false, true),
      series: [
        {
          type: "scatter",
          symbolSize: 8,
          itemStyle: { color: c.series[0], opacity: 0.55, borderColor: c.bg, borderWidth: 1 },
          large: data.x.length > 2000,
          data: data.x.map((x, i) => [x, data.series[0]?.values[i] ?? null]),
        },
      ],
    };
  }

  if (data.kind === "pie") {
    const values = data.series[0]?.values ?? [];
    const slices = data.x.map((x, i) => ({
      name: x == null ? "null" : formatX(data, x, chart.bucket),
      value: values[i] ?? 0,
      itemStyle: { color: c.series[i % c.series.length] },
    }));
    if (data.other)
      slices.push({ name: "Other", value: data.other, itemStyle: { color: c.subtle } });
    return {
      ...base,
      legend: { type: "scroll", orient: "vertical", right: 0, top: "middle", textStyle: text },
      tooltip: {
        ...tooltip,
        trigger: "item",
        formatter: (p: { name: string; value: number; percent: number }) =>
          `${p.name}<br/><b>${formatNumber(p.value)}</b> (${p.percent.toFixed(1)}%)`,
      },
      series: [
        {
          type: "pie",
          name: data.series[0]?.name,
          radius: chart.donut ? ["45%", "72%"] : [0, "72%"],
          center: ["40%", "50%"],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: c.bg, borderWidth: 2, borderRadius: 3 },
          label: { ...text, color: c.fg, formatter: "{b}" },
          labelLine: { lineStyle: { color: c.border } },
          data: slices,
        },
      ],
    };
  }

  if (data.kind === "box") {
    const at = (s: number, i: number) => data.series[s]?.values[i] ?? null;
    return {
      ...base,
      grid: { ...(base.grid as object), top: 24 },
      tooltip: {
        ...tooltip,
        trigger: "item",
        formatter: (p: { dataIndex: number }) => {
          const i = p.dataIndex;
          const rows = ["Max", "Q3", "Median", "Q1", "Min"].map(
            (n, k) => `${n}: <b>${formatNumber(at(4 - k, i))}</b>`,
          );
          return [
            `<span style="color:${c.muted}">${formatX(data, data.x[i] ?? null)} · ${formatCount(at(5, i) ?? 0)} values</span>`,
            ...rows,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: data.x.map((v) => (v == null ? "null" : String(v))),
        axisLabel: { ...text, hideOverlap: true },
        axisLine,
        axisTick: { show: false },
      },
      yAxis: valueAxis(labels.y, false, true),
      series: [
        {
          type: "boxplot",
          name: labels.y,
          boxWidth: [6, 32],
          itemStyle: { color: c.surface, borderColor: c.series[0], borderWidth: 1.5 },
          emphasis: { itemStyle: { borderColor: c.series[1], borderWidth: 2 } },
          data: data.x.map((_, i) => [at(0, i), at(1, i), at(2, i), at(3, i), at(4, i)]),
        },
      ],
    };
  }

  const horizontal = data.kind === "horizontalBar";
  const line = data.kind === "line";
  const category = data.xKind === "category";
  const categoryAxis = {
    type: "category",
    data: data.x.map((v) => (v == null ? "null" : String(v))),
    axisLabel: { ...text, hideOverlap: true },
    axisLine,
    axisTick: { show: false },
    inverse: horizontal,
  };
  const xAxis = category ? categoryAxis : valueAxis(undefined, data.xKind === "time");
  const stacked = !!chart.stacked && !line;
  const series = data.series.map((s, i) => ({
    name: s.name,
    type: line ? "line" : "bar",
    barMaxWidth: 24,
    barCategoryGap: "30%",
    showSymbol: line && data.x.length <= 60,
    symbolSize: 8,
    lineStyle: { width: 2 },
    itemStyle: line
      ? { borderColor: c.bg, borderWidth: 2 }
      : {
          // A stack is rounded once, at its end.
          borderRadius:
            stacked && i < data.series.length - 1 ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
          // A split's "Other" is grey.
          ...(chart.splitBy && s.name === "Other" && { color: c.subtle }),
        },
    emphasis: { focus: "series" },
    // Stacked bars share one stack; a split's "Other" is grey.
    ...(stacked && { stack: "total" }),
    data: category ? s.values : data.x.map((x, i) => [x, s.values[i] ?? null]),
  }));
  return {
    ...base,
    grid: { ...(base.grid as object), top: multi ? 32 : 16 },
    legend,
    tooltip: {
      ...tooltip,
      trigger: "axis",
      axisPointer: { type: line ? "line" : "shadow", lineStyle: { color: c.subtle } },
      valueFormatter: (v: number | null) => formatNumber(v),
      formatter: (
        params: { dataIndex: number; seriesName: string; color: string; value: unknown }[],
      ) => {
        const i = params[0]?.dataIndex ?? 0;
        const head = formatX(data, data.x[i] ?? null, chart.bucket);
        const rows = params.map((p) => {
          const v = Array.isArray(p.value)
            ? (p.value[1] as number | null)
            : (p.value as number | null);
          return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:6px"></span>${p.seriesName}: <b>${formatNumber(v)}</b>`;
        });
        return [`<span style="color:${c.muted}">${head}</span>`, ...rows].join("<br/>");
      },
    },
    xAxis: horizontal ? valueAxis() : xAxis,
    yAxis: horizontal ? xAxis : valueAxis(),
    series,
  };
}
