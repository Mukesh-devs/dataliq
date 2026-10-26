import type { Table } from "apache-arrow";
import { useMemo } from "react";
import { cellValue, describeColumns, type ColumnKind } from "../../lib/arrow";
import { cn } from "../../lib/cn";
import { formatValue } from "../../lib/format";

const RIGHT_ALIGNED: ColumnKind[] = ["integer", "number"];

/**
 * Simple preview of the first rows. Replaced by the virtualized data grid in
 * v0.1 step 6; kept small on purpose.
 */
export function PreviewTable({ table, maxRows = 200 }: { table: Table; maxRows?: number }) {
  const columns = useMemo(() => describeColumns(table), [table]);
  const rows = Math.min(table.numRows, maxRows);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="border-separate border-spacing-0 font-mono text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>
            <th className="sticky left-0 border-r border-b border-border bg-surface px-2 text-right font-normal text-fg-subtle">
              #
            </th>
            {columns.map((c) => (
              <th
                key={c.name}
                scope="col"
                title={c.type}
                className="h-[var(--row-height)] border-r border-b border-border px-2 text-left font-sans font-medium whitespace-nowrap text-fg"
              >
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              <td className="tabular sticky left-0 border-r border-b border-border bg-surface px-2 text-right text-fg-subtle">
                {r + 1}
              </td>
              {columns.map((c, ci) => {
                const text = formatValue(cellValue(table, r, ci), c.kind);
                return (
                  <td
                    key={c.name}
                    className={cn(
                      "h-[var(--row-height)] max-w-80 truncate border-r border-b border-border px-2 whitespace-nowrap",
                      RIGHT_ALIGNED.includes(c.kind) && "tabular text-right",
                    )}
                  >
                    {text === null ? (
                      <span className="text-[var(--null)] italic">null</span>
                    ) : text === "" ? (
                      <span className="text-fg-subtle" title="Empty string">
                        ""
                      </span>
                    ) : (
                      text
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
