import * as Popover from "@radix-ui/react-popover";
import { Copy, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatStatNumber, type ColumnStats, type SelectionStats } from "../../lib/selectionStats";
import { Button, IconButton } from "../ui/Button";

interface SelectionSummaryProps {
  /** Adds up the selection, per column (distinct values included). */
  load: () => Promise<SelectionStats>;
  onClose: () => void;
  /** A column's display name. */
  labelOf: (column: string) => string;
  /** Copies text and says so. */
  onCopy: (text: string, what: string) => void;
}

const HEADERS = ["Column", "Values", "Blank", "Distinct", "Sum", "Average", "Min", "Max"];

/** One column's row of the table, as text. */
function cells(c: ColumnStats, rows: number, approx: boolean, labelOf: (c: string) => string) {
  const n = (v: number | null) => (v === null ? "" : formatStatNumber(v));
  return [
    labelOf(c.column),
    c.values.toLocaleString("en-US"),
    (rows - c.values + c.empty).toLocaleString("en-US"),
    c.distinct === null ? "" : `${approx ? "≈" : ""}${c.distinct.toLocaleString("en-US")}`,
    n(c.sum),
    n(c.avg),
    c.min !== null ? n(c.min) : (c.minText ?? ""),
    c.max !== null ? n(c.max) : (c.maxText ?? ""),
  ];
}

/** Plain values for the clipboard (no separators), tab-separated. */
function asTsv(stats: SelectionStats, labelOf: (c: string) => string): string {
  const v = (x: number | null) => (x === null ? "" : String(x));
  const rows = stats.columns.map((c) =>
    [
      labelOf(c.column),
      String(c.values),
      String(stats.rows - c.values + c.empty),
      v(c.distinct),
      v(c.sum),
      v(c.avg),
      c.min !== null ? v(c.min) : (c.minText ?? ""),
      c.max !== null ? v(c.max) : (c.maxText ?? ""),
    ].join("\t"),
  );
  return [HEADERS.join("\t"), ...rows].join("\n");
}

/** "Summarize selection by column": count, blanks, distinct, sum, average, min and max. */
export function SelectionSummary({ load, onClose, labelOf, onCopy }: SelectionSummaryProps) {
  const [state, setState] = useState<
    { stats: SelectionStats } | { error: string } | { loading: true }
  >({ loading: true });
  useEffect(() => {
    let alive = true;
    load().then(
      (stats) => alive && setState({ stats }),
      (e: unknown) => {
        if (!alive || (e as { kind?: string }).kind === "cancelled") return;
        setState({ error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [load]);
  const stats = "stats" in state ? state.stats : null;
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Selection summary"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 flex max-h-[70vh] max-w-[min(960px,92vw)] flex-col gap-2 rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <div className="flex items-center gap-2">
            <h2 className="flex-1 font-semibold text-fg">
              Selection by column
              {stats && (
                <span className="ml-2 font-normal text-fg-muted">
                  {stats.rows.toLocaleString("en-US")} {stats.rows === 1 ? "row" : "rows"}
                </span>
              )}
            </h2>
            {stats && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onCopy(asTsv(stats, labelOf), "the summary")}
              >
                <Copy className="size-3.5" aria-hidden /> Copy
              </Button>
            )}
            <IconButton label="Close" onClick={onClose} className="size-6">
              <X className="size-3.5" aria-hidden />
            </IconButton>
          </div>
          {"loading" in state && (
            <p role="status" className="flex items-center gap-2 text-fg-muted">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Adding up…
            </p>
          )}
          {"error" in state && (
            <p role="alert" className="text-fg-muted">
              Couldn’t add up the selection: {state.error}
            </p>
          )}
          {stats && (
            <div className="min-h-0 overflow-auto">
              <table className="tabular w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    {HEADERS.map((h, i) => (
                      <th
                        key={h}
                        scope="col"
                        className={`sticky top-0 border-b border-border bg-bg px-2 py-1 font-semibold whitespace-nowrap text-fg-muted ${i === 0 ? "text-left" : "text-right"}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.columns.map((c) => (
                    <tr key={c.column} className="hover:bg-hover">
                      {cells(c, stats.rows, stats.distinctApprox, labelOf).map((text, i) =>
                        i === 0 ? (
                          <th
                            key={i}
                            scope="row"
                            className="max-w-48 truncate px-2 py-1 text-left font-medium text-fg"
                            title={text}
                          >
                            {text}
                          </th>
                        ) : (
                          <td
                            key={i}
                            className="max-w-48 truncate px-2 py-1 text-right font-mono text-fg"
                            title={text}
                          >
                            {text}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
