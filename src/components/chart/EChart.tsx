import { BarChart, CustomChart, LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

// Only the chart types and parts DataLiq draws (keeps the bundle small).
echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export interface EChartHandle {
  /** The chart as a PNG data URL at `pixelRatio` (2 = sharp on most screens). */
  png(background: string, pixelRatio?: number): string | null;
  /** The chart drawn again as a standalone SVG document. */
  svg(background: string): string | null;
}

interface EChartProps {
  option: Record<string, unknown>;
  /** Accessible name of the chart. */
  label: string;
}

/** An ECharts canvas that fills its parent and follows its size. */
export const EChart = forwardRef<EChartHandle, EChartProps>(function EChart(
  { option, label },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useLayoutEffect(() => {
    if (!host.current) return;
    const c = echarts.init(host.current, undefined, { renderer: "canvas" });
    chart.current = c;
    const resize = new ResizeObserver(() => c.resize());
    resize.observe(host.current);
    return () => {
      resize.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  useImperativeHandle(
    ref,
    () => ({
      png(background, pixelRatio = 2) {
        return (
          chart.current?.getDataURL({ type: "png", pixelRatio, backgroundColor: background }) ??
          null
        );
      },
      svg(background) {
        const c = chart.current;
        if (!c) return null;
        // Drawn again with the SVG renderer at the same size, off screen.
        const el = document.createElement("div");
        const out = echarts.init(el, undefined, {
          renderer: "svg",
          ssr: true,
          width: c.getWidth(),
          height: c.getHeight(),
        });
        out.setOption({ ...option, animation: false, backgroundColor: background });
        const svg = out.renderToSVGString();
        out.dispose();
        return svg;
      },
    }),
    [option],
  );

  return (
    <div
      ref={host}
      role="img"
      aria-label={label}
      data-testid="chart"
      className="h-full min-h-0 w-full min-w-0"
    />
  );
});
