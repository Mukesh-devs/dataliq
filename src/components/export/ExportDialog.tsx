import * as Popover from "@radix-ui/react-popover";
import { TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  EXPORT_FORMATS,
  XLSX_SHEET_ROWS,
  defaultExportName,
  pickExportPath,
  rangeRows,
  type ExportFormat,
} from "../../lib/exporting";
import { formatCount } from "../../lib/format";
import { optionsFor, useExport, type ExportDefaults, type ExportTarget } from "../../stores/export";
import { useNotice } from "../../stores/notice";
import { Button } from "../ui/Button";

const DELIMITERS: { label: string; value: string }[] = [
  { label: "Comma ,", value: "," },
  { label: "Semicolon ;", value: ";" },
  { label: "Pipe |", value: "|" },
  { label: "Tab", value: "\t" },
];

const CSV_LIKE = new Set<ExportFormat>(["csv", "csvGz", "tsv"]);
const DATED = new Set<ExportFormat>(["csv", "csvGz", "tsv", "json", "ndjson"]);

const inputClass =
  "h-7 w-full rounded-[var(--radius)] border border-border bg-bg px-2 text-fg outline-none focus:border-accent";

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
      <span className="text-fg-muted">{label}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        {children}
        {hint && <span className="text-[11px] text-fg-subtle">{hint}</span>}
      </span>
    </label>
  );
}

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

/** "Export…" (Ctrl+E): the view or a SQL result to a file in any format. */
export function ExportDialog() {
  const target = useExport((s) => s.target);
  const close = useExport((s) => s.close);
  return (
    <Popover.Root open={target !== null} onOpenChange={(o) => !o && close()}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Export"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-[min(30rem,calc(100vw-32px))] rounded-[var(--radius-lg)] border border-border bg-bg p-4 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          {/* A fresh form for each target. */}
          {target && <ExportForm key={target.datasetId + target.title} target={target} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ExportForm({ target }: { target: ExportTarget }) {
  const defaults = useExport((s) => s.defaults);
  const setDefaults = useExport((s) => s.setDefaults);
  const start = useExport((s) => s.start);
  const close = useExport((s) => s.close);
  const busy = useExport((s) => s.job !== null);
  const notice = useNotice((s) => s.show);
  const selection = target.selection ?? null;
  const [scope, setScope] = useState<"view" | "selection">("view");
  const d = defaults;
  const update = (changes: Partial<ExportDefaults>) => setDefaults(changes);

  const columns = (scope === "selection" && selection?.columns) || target.spec.columns || [];
  const rows = scope === "selection" && selection ? rangeRows(selection.rows) : target.rowCount;
  const overSheet = d.format === "xlsx" && rows > XLSX_SHEET_ROWS;
  const sheets = Math.ceil(rows / XLSX_SHEET_ROWS);

  const run = async () => {
    const path = await pickExportPath(defaultExportName(target.title, d.format), d.format).catch(
      (e: unknown) => {
        notice(`Couldn't choose a file: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      },
    );
    if (!path) return;
    close();
    const sel = scope === "selection" ? selection : null;
    await start({
      datasetId: target.datasetId,
      spec: { ...target.spec, columns: sel ? sel.columns : target.spec.columns },
      labels: target.labels,
      path,
      format: d.format,
      options: { ...optionsFor(d), rows: sel ? sel.rows : undefined },
      totalRows: rows,
    });
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <h2 className="font-semibold text-fg">Export {target.title}</h2>
      <div role="radiogroup" aria-label="Format" className="grid grid-cols-4 gap-1">
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f.format}
            type="button"
            role="radio"
            aria-checked={d.format === f.format}
            title={f.hint}
            onClick={() => update({ format: f.format })}
            className={`h-8 rounded-[var(--radius)] border text-[12px] font-medium ${
              d.format === f.format
                ? "border-accent bg-accent-soft text-accent"
                : "border-border text-fg hover:bg-hover"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="-mt-1 text-[11px] text-fg-subtle">
        {EXPORT_FORMATS.find((f) => f.format === d.format)?.hint}
      </p>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-fg-muted">Rows and columns</legend>
        <label className="flex items-center gap-2 text-fg">
          <input
            type="radio"
            name="scope"
            checked={scope === "view"}
            onChange={() => setScope("view")}
          />
          The whole view: {plural(target.rowCount, "row")},{" "}
          {plural(target.spec.columns?.length ?? 0, "column")}
        </label>
        <label className={`flex items-center gap-2 ${selection ? "text-fg" : "text-fg-subtle"}`}>
          <input
            type="radio"
            name="scope"
            disabled={!selection}
            checked={scope === "selection"}
            onChange={() => setScope("selection")}
          />
          {selection
            ? `The selection: ${plural(rangeRows(selection.rows), "row")}, ${plural(
                selection.columns.length,
                "column",
              )}`
            : "The selection (select cells, rows or columns first)"}
        </label>
      </fieldset>

      {(CSV_LIKE.has(d.format) || d.format === "xlsx") && (
        <label className="flex items-center gap-2 text-fg">
          <input
            type="checkbox"
            checked={d.header}
            onChange={(e) => update({ header: e.target.checked })}
          />
          Column names in the first row
        </label>
      )}
      {CSV_LIKE.has(d.format) && (
        <label className="flex items-center gap-2 text-fg">
          <input
            type="checkbox"
            checked={d.quoteAll}
            onChange={(e) => update({ quoteAll: e.target.checked })}
          />
          Quote every value
        </label>
      )}
      {(d.format === "csv" || d.format === "csvGz") && (
        <Field label="Delimiter">
          <select
            aria-label="Delimiter"
            className={inputClass}
            value={d.delimiter}
            onChange={(e) => update({ delimiter: e.target.value })}
          >
            {DELIMITERS.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {DATED.has(d.format) && (
        <>
          <Field label="Date format" hint="strftime, e.g. %d/%m/%Y; empty = 2024-01-31">
            <input
              aria-label="Date format"
              className={`${inputClass} font-mono`}
              placeholder="%Y-%m-%d"
              value={d.dateFormat}
              onChange={(e) => update({ dateFormat: e.target.value })}
            />
          </Field>
          <Field label="Timestamp format">
            <input
              aria-label="Timestamp format"
              className={`${inputClass} font-mono`}
              placeholder="%Y-%m-%d %H:%M:%S"
              value={d.timestampFormat}
              onChange={(e) => update({ timestampFormat: e.target.value })}
            />
          </Field>
        </>
      )}
      {d.format === "parquet" && (
        <p className="text-[12px] text-fg-muted">
          Compressed with zstd; column types are kept exactly.
        </p>
      )}
      {overSheet && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-surface p-2 text-[12px]"
        >
          <span className="flex items-start gap-2 text-fg">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            Excel holds {formatCount(XLSX_SHEET_ROWS)} rows per sheet; this export has{" "}
            {formatCount(rows)}.
          </span>
          <label className="flex items-center gap-2 text-fg">
            <input
              type="radio"
              name="sheets"
              checked={d.splitSheets}
              onChange={() => update({ splitSheets: true })}
            />
            Split into {sheets} sheets
          </label>
          <label className="flex items-center gap-2 text-fg">
            <input
              type="radio"
              name="sheets"
              checked={!d.splitSheets}
              onChange={() => update({ splitSheets: false })}
            />
            Only the first {formatCount(XLSX_SHEET_ROWS)} rows
          </label>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        {busy && <span className="mr-auto text-[12px] text-fg-subtle">An export is running</span>}
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={busy || columns.length === 0 || rows === 0}
        >
          Export {plural(rows, "row")}…
        </Button>
      </div>
    </form>
  );
}
