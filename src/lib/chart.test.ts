/* eslint-disable @typescript-eslint/no-explicit-any -- ECharts options are loosely typed; the tests read deep fields */
import { describe, expect, it } from "vitest";
import type { ColumnInfo, ColumnKind } from "./arrow";
import {
  chartNote,
  chartOption,
  chartTable,
  defaultChart,
  fitChart,
  formatTime,
  type ChartColors,
  type ChartData,
} from "./chart";

const col = (name: string, kind: ColumnKind): ColumnInfo => ({
  name,
  kind,
  type: kind,
  nullable: true,
});
const columns = [
  col("city", "text"),
  col("amount", "number"),
  col("qty", "integer"),
  col("joined", "date"),
];

const colors: ChartColors = {
  series: ["#s1", "#s2", "#s3", "#s4"],
  fg: "#fg",
  muted: "#muted",
  subtle: "#subtle",
  border: "#border",
  surface: "#surface",
  bg: "#bg",
  font: "Inter",
  mono: "Mono",
};

const bars: ChartData = {
  kind: "bar",
  xKind: "category",
  x: ["Paris", "Berlin", null],
  series: [
    { name: "Count", values: [10, 8, 1] },
    { name: "Sum of amount", values: [100.5, 80, null] },
  ],
  bins: [],
  total: 7,
  truncated: true,
  elapsedMs: 12,
};

describe("chart helpers", () => {
  it("starts with dates over time, else groups, else a histogram", () => {
    expect(defaultChart(columns)).toEqual({
      kind: "line",
      x: "joined",
      bucket: "month",
      measures: [{ agg: "count" }],
    });
    expect(defaultChart(columns.slice(0, 3))).toMatchObject({ kind: "bar", x: "city" });
    expect(defaultChart([col("amount", "number")])).toEqual({ kind: "histogram", x: "amount" });
    expect(defaultChart([col("blob", "binary")])).toBeNull();
  });

  it("keeps a chart valid when its type changes", () => {
    // A histogram needs a number or date column.
    expect(fitChart({ kind: "histogram", x: "city" }, columns).x).toBe("amount");
    // A scatter gets a y axis different from x.
    expect(fitChart({ kind: "scatter", x: "amount" }, columns)).toMatchObject({
      x: "amount",
      y: "qty",
    });
    // Buckets only for dates; sums only of numbers; at most 4 measures.
    const fitted = fitChart(
      {
        kind: "bar",
        x: "city",
        bucket: "month",
        measures: [
          { agg: "sum", column: "city" },
          { agg: "sum", column: "amount" },
          { agg: "count" },
          { agg: "avg", column: "qty" },
          { agg: "max", column: "qty" },
          { agg: "min", column: "qty" },
        ],
      },
      columns,
    );
    expect(fitted.bucket).toBeUndefined();
    expect(fitted.measures).toEqual([
      { agg: "sum", column: "amount" },
      { agg: "count" },
      { agg: "avg", column: "qty" },
      { agg: "max", column: "qty" },
    ]);
    expect(fitChart({ kind: "line", x: "city", measures: [] }, columns).measures).toEqual([
      { agg: "count" },
    ]);
  });

  it("says when a chart shows part of the data", () => {
    expect(chartNote(bars)).toBe("Top 3 of 7 groups");
    expect(chartNote({ ...bars, truncated: false, total: 3 })).toBe("3 groups");
    expect(
      chartNote({ ...bars, kind: "scatter", xKind: "number", x: [1, 2], total: 1_000_000 }),
    ).toBe("2 of 1,000,000 points (random sample)");
    expect(chartNote({ ...bars, kind: "histogram", total: 42 })).toBe("42 values");
    // A time axis can't place a group of rows without a date.
    const line: ChartData = { ...bars, kind: "line", xKind: "time", x: [1, 2, null], total: 3 };
    expect(chartNote({ ...line, truncated: false })).toBe("2 points · empty dates not drawn");
  });

  it("formats times as precisely as the bucket", () => {
    const ms = Date.UTC(2024, 0, 31, 13, 5, 0);
    expect(formatTime(ms, "year")).toBe("2024");
    expect(formatTime(ms, "month")).toBe("2024-01");
    expect(formatTime(Date.UTC(2024, 0, 29), "week")).toBe("Week of 2024-01-29");
    expect(formatTime(ms)).toBe("2024-01-31 13:05:00");
    expect(formatTime(Date.UTC(2024, 0, 31))).toBe("2024-01-31");
  });

  it("lists the values as a table", () => {
    expect(chartTable(bars)).toEqual({
      head: ["Group", "Count", "Sum of amount"],
      rows: [
        ["Paris", "10", "100.5"],
        ["Berlin", "8", "80"],
        ["null", "1", "null"],
      ],
    });
    const hist: ChartData = {
      ...bars,
      kind: "histogram",
      xKind: "number",
      x: [],
      series: [],
      bins: [{ lo: 0, hi: 5, count: 1234 }],
    };
    expect(chartTable(hist).rows).toEqual([["0", "5", "1,234"]]);
  });
});

describe("chartOption", () => {
  it("bars: thin with rounded ends, a legend for two series, colours in order", () => {
    const o = chartOption(bars, { kind: "bar", x: "city" }, colors) as Record<string, any>;
    expect(o.color).toEqual(colors.series);
    expect(o.legend).toBeDefined();
    expect(o.series).toHaveLength(2);
    expect(o.series[0]).toMatchObject({
      type: "bar",
      barMaxWidth: 24,
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      data: [10, 8, 1],
    });
    expect(o.xAxis).toMatchObject({ type: "category", data: ["Paris", "Berlin", "null"] });
    // Text in text colours, never the series colour.
    expect(o.xAxis.axisLabel.color).toBe("#muted");
    expect(o.yAxis.splitLine.lineStyle.color).toBe("#border");
  });

  it("horizontal bars put the groups on the y axis, largest at the top", () => {
    const o = chartOption(
      { ...bars, kind: "horizontalBar", series: [bars.series[0]!] },
      { kind: "horizontalBar", x: "city" },
      colors,
    ) as Record<string, any>;
    expect(o.yAxis).toMatchObject({ type: "category", inverse: true });
    expect(o.xAxis.type).toBe("value");
    expect(o.series[0].itemStyle.borderRadius).toEqual([0, 4, 4, 0]);
    // One series: no legend box.
    expect(o.legend).toBeUndefined();
  });

  it("lines over time: a time axis, 2 px lines, an axis tooltip", () => {
    const line: ChartData = {
      ...bars,
      kind: "line",
      xKind: "time",
      x: [Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1)],
      series: [{ name: "Count", values: [3, 5] }],
    };
    const o = chartOption(line, { kind: "line", x: "joined", bucket: "month" }, colors) as Record<
      string,
      any
    >;
    expect(o.xAxis.type).toBe("time");
    expect(o.series[0]).toMatchObject({ type: "line", lineStyle: { width: 2 } });
    expect(o.series[0].data).toEqual([
      [Date.UTC(2024, 0, 1), 3],
      [Date.UTC(2024, 1, 1), 5],
    ]);
    expect(o.tooltip.trigger).toBe("axis");
    expect(
      o.tooltip.formatter([{ dataIndex: 1, seriesName: "Count", color: "#s1", value: [0, 5] }]),
    ).toContain("2024-02");
  });

  it("histograms and scatter plots", () => {
    const hist: ChartData = {
      ...bars,
      kind: "histogram",
      xKind: "number",
      x: [],
      series: [],
      bins: [
        { lo: 0, hi: 10, count: 4 },
        { lo: 10, hi: 20, count: 6 },
      ],
    };
    const h = chartOption(hist, { kind: "histogram", x: "amount" }, colors) as Record<string, any>;
    expect(h.series[0].type).toBe("custom");
    expect(h.series[0].data).toEqual([
      [0, 10, 4],
      [10, 20, 6],
    ]);
    const scatter: ChartData = {
      ...bars,
      kind: "scatter",
      xKind: "number",
      x: [1, 2],
      series: [{ name: "qty", values: [3, 4] }],
    };
    const s = chartOption(scatter, { kind: "scatter", x: "amount", y: "qty" }, colors, {
      x: "Amount",
      y: "Quantity",
    }) as Record<string, any>;
    expect(s.series[0]).toMatchObject({ type: "scatter", symbolSize: 8 });
    expect(s.series[0].data).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(s.tooltip.formatter({ value: [2, 4] })).toBe("Amount: <b>2</b><br/>Quantity: <b>4</b>");
  });
});

describe("pies, box plots and split series", () => {
  const data = (over: Partial<ChartData>): ChartData => ({
    kind: "bar",
    xKind: "category",
    x: ["Paris", "Oslo"],
    series: [{ name: "Count", values: [5, 3] }],
    bins: [],
    total: 2,
    truncated: false,
    elapsedMs: 1,
    ...over,
  });

  it("keeps a pie to one measure and a split to one series measure", () => {
    const pie = fitChart(
      {
        kind: "pie",
        x: "city",
        measures: [{ agg: "count" }, { agg: "sum", column: "amount" }],
        splitBy: "qty",
        stacked: true,
      },
      columns,
    );
    expect(pie.measures).toEqual([{ agg: "count" }]);
    expect(pie.splitBy).toBeUndefined();
    expect(pie.stacked).toBeUndefined();
    const bar = fitChart(
      {
        kind: "bar",
        x: "city",
        splitBy: "qty",
        measures: [{ agg: "count" }, { agg: "sum", column: "amount" }],
      },
      columns,
    );
    expect(bar.measures).toHaveLength(1);
    expect(bar.splitBy).toBe("qty");
    // Not by the axis column itself, nor a column that is gone.
    expect(fitChart({ kind: "bar", x: "city", splitBy: "city" }, columns).splitBy).toBeUndefined();
    expect(fitChart({ kind: "line", x: "city", splitBy: "gone" }, columns).splitBy).toBeUndefined();
  });

  it("gives a box plot a number column", () => {
    const box = fitChart({ kind: "box", x: "city", measures: [{ agg: "count" }] }, columns);
    expect(box.y).toBe("amount");
    expect(box.measures).toBeUndefined();
    expect(fitChart({ ...box, y: "city" }, columns).y).toBe("amount");
  });

  it("draws slices with the rest as a grey Other, as a ring when asked", () => {
    const o = chartOption(
      data({ kind: "pie", truncated: true, other: 12 }),
      { kind: "pie", x: "city", donut: true },
      colors,
    ) as any;
    const s = o.series[0];
    expect(s.type).toBe("pie");
    expect(s.radius).toEqual(["45%", "72%"]);
    expect(s.data.map((d: any) => [d.name, d.value])).toEqual([
      ["Paris", 5],
      ["Oslo", 3],
      ["Other", 12],
    ]);
    expect(s.data[2].itemStyle.color).toBe(colors.subtle);
    expect(chartTable(data({ kind: "pie", other: 12 })).rows.at(-1)).toEqual(["Other", "12"]);
  });

  it("draws a box per group from the five numbers", () => {
    const five = [1, 2, 3, 4, 5, 10].map((v, i) => ({ name: `s${i}`, values: [v, v * 2] }));
    const o = chartOption(
      data({ kind: "box", series: five }),
      { kind: "box", x: "city", y: "amount" },
      colors,
      {
        x: "city",
        y: "amount",
      },
    ) as any;
    expect(o.series[0].type).toBe("boxplot");
    expect(o.series[0].data).toEqual([
      [1, 2, 3, 4, 5],
      [2, 4, 6, 8, 10],
    ]);
    expect(o.xAxis.data).toEqual(["Paris", "Oslo"]);
  });

  it("stacks bars and greys a split's Other", () => {
    const split = data({
      series: [
        { name: "true", values: [1, 2] },
        { name: "Other", values: [3, 4] },
      ],
    });
    const o = chartOption(
      split,
      { kind: "bar", x: "city", splitBy: "active", stacked: true },
      colors,
    ) as any;
    expect(o.series.map((s: any) => s.stack)).toEqual(["total", "total"]);
    expect(o.series[1].itemStyle.color).toBe(colors.subtle);
    // Only the top of the stack is rounded.
    expect(o.series.map((s: any) => s.itemStyle.borderRadius)).toEqual([0, [4, 4, 0, 0]]);
    const lines = chartOption(split, { kind: "line", x: "city", splitBy: "active" }, colors) as any;
    expect(lines.series[0].stack).toBeUndefined();
  });
});
