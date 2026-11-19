import { RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import type { ExcelInfo, ExcelOptions } from "../../lib/files";

interface ExcelSettingsProps {
  info: ExcelInfo;
  /** The header row was found by DataLiq, not chosen. */
  auto?: boolean;
  onChange: (options: ExcelOptions) => void;
}

/** Excel's last row: the header can't be below it. */
export const MAX_EXCEL_ROW = 1_048_576;

const fieldClass =
  "h-6 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-[12px] text-fg outline-none focus:border-accent";

/** Sheet picker and header row for Excel files. */
export function ExcelSettings({ info, auto = true, onChange }: ExcelSettingsProps) {
  return (
    <div className="flex items-center gap-3 text-[12px] text-fg-muted">
      <label className="flex items-center gap-1.5">
        <span className="tb-label">Sheet</span>
        <select
          aria-label="Sheet"
          className={fieldClass}
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
        <span className="tb-label">Header</span>
        <HeaderRow
          value={info.headerRow}
          onCommit={(headerRow) => onChange({ sheet: info.sheet, headerRow })}
        />
        {info.headerRow === 0 && <span className="tb-label">none</span>}
      </label>
      {!auto && (
        <button
          type="button"
          aria-label="Find the header row again"
          title="Find the header row again"
          className="-ml-2 flex size-6 items-center justify-center rounded-[var(--radius)] hover:bg-hover hover:text-fg"
          onClick={() => onChange({ sheet: info.sheet })}
        >
          <RotateCcw className="size-3" aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * The header row as a number you type (any row of the sheet; 0 for none),
 * not a list: a list only had room for some rows. It applies on Enter or on
 * leaving the box, since each change reads the sheet again; Escape puts the
 * current row back, and so does anything that isn't a row number.
 */
function HeaderRow({ value, onCommit }: { value: number; onCommit: (row: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  // A new value from the file (another sheet, a re-read) replaces the draft.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(String(value));
  }
  const cancelled = useRef(false);
  const commit = () => {
    const row = Number(draft);
    if (draft.trim() === "" || !Number.isInteger(row) || row < 0 || row > MAX_EXCEL_ROW) {
      setDraft(String(value));
      return;
    }
    if (row !== value) onCommit(row);
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={MAX_EXCEL_ROW}
      step={1}
      aria-label="Header row"
      title="The row with the column names (0: no header row). Enter or leave the box to apply."
      className={`${fieldClass} tabular w-16`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) cancelled.current = false;
        else commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          setDraft(String(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}
