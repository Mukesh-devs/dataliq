import type { ExcelInfo, ExcelOptions } from "../../lib/files";

interface ExcelSettingsProps {
  info: ExcelInfo;
  onChange: (options: ExcelOptions) => void;
}

const selectClass =
  "h-6 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-[12px] text-fg outline-none focus:border-accent";

/** Sheet picker and header row choice for Excel files. */
export function ExcelSettings({ info, onChange }: ExcelSettingsProps) {
  const rows = Array.from({ length: Math.max(10, info.headerRow) }, (_, i) => i + 1);
  return (
    <div className="flex items-center gap-3 text-[12px] text-fg-muted">
      <label className="flex items-center gap-1.5">
        Sheet
        <select
          aria-label="Sheet"
          className={selectClass}
          value={info.sheet}
          // A new sheet gets its own header detection.
          onChange={(e) => onChange({ sheet: e.target.value })}
        >
          {info.sheets.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        Header
        <select
          aria-label="Header row"
          className={selectClass}
          value={info.headerRow}
          onChange={(e) => onChange({ sheet: info.sheet, headerRow: Number(e.target.value) })}
        >
          <option value={0}>No header row</option>
          {rows.map((r) => (
            <option key={r} value={r}>
              Row {r}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
