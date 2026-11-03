import { useState } from "react";
import { formatCount } from "../../lib/format";
import type { SampleSpec } from "../../lib/tools";
import { ToolDialog, ViewToggle, fieldClass, labelClass } from "./ToolDialog";

interface SampleDialogProps {
  /** Rows the sample is taken from (for the hint). */
  rowCount?: number;
  hasView: boolean;
  onClose: () => void;
  onRun: (spec: SampleSpec, withView: boolean) => Promise<void>;
}

type Method = SampleSpec["method"];

const METHODS: { method: Method; label: string; help: string }[] = [
  { method: "rows", label: "Random rows", help: "A fixed number of rows picked at random" },
  { method: "percent", label: "Random share", help: "Each row kept with this chance" },
  { method: "first", label: "First rows", help: "The first rows, in the view's order" },
];

/** Opens a smaller sample of a big file as a tab, for quick exploring. */
export function SampleDialog({ rowCount, hasView, onClose, onRun }: SampleDialogProps) {
  const [method, setMethod] = useState<Method>("rows");
  const [rows, setRows] = useState("10000");
  const [percent, setPercent] = useState("1");
  const [seed, setSeed] = useState("42");
  const [withView, setWithView] = useState(hasView);
  const n = Number(rows.replace(/[,_\s]/g, ""));
  const p = Number(percent);
  const s = Number(seed);
  const valid =
    method === "percent" ? Number.isFinite(p) && p > 0 && p <= 100 : Number.isInteger(n) && n >= 1;
  const spec: SampleSpec =
    method === "first"
      ? { method, rows: n }
      : method === "rows"
        ? { method, rows: n, seed: Number.isInteger(s) ? s : 42 }
        : { method, percent: p, seed: Number.isInteger(s) ? s : 42 };
  return (
    <ToolDialog
      title="Open a sample"
      runLabel="Open sample"
      onClose={onClose}
      blocked={
        valid
          ? undefined
          : method === "percent"
            ? "A share from 0 to 100%"
            : "A whole number of rows"
      }
      onRun={() => onRun(spec, withView)}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className={`mb-1 ${labelClass}`}>
          Sample of {rowCount !== undefined ? `${formatCount(rowCount)} rows` : "the rows"}
        </legend>
        {METHODS.map((m) => (
          <label key={m.method} className="flex items-start gap-1.5 text-fg">
            <input
              type="radio"
              name="sample-method"
              className="mt-0.5"
              checked={method === m.method}
              onChange={() => setMethod(m.method)}
            />
            <span>
              {m.label} <span className="text-fg-subtle">— {m.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        {method === "percent" ? (
          <label className="flex flex-1 flex-col gap-1">
            <span className={labelClass}>Share of rows (%)</span>
            <input
              className={fieldClass}
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </label>
        ) : (
          <label className="flex flex-1 flex-col gap-1">
            <span className={labelClass}>Rows</span>
            <input
              className={fieldClass}
              inputMode="numeric"
              value={rows}
              onChange={(e) => setRows(e.target.value)}
            />
          </label>
        )}
        {method !== "first" && (
          <label className="flex w-28 flex-col gap-1" title="The same seed picks the same rows">
            <span className={labelClass}>Seed</span>
            <input
              className={fieldClass}
              inputMode="numeric"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            />
          </label>
        )}
      </div>
      {hasView && <ViewToggle value={withView} onChange={setWithView} />}
    </ToolDialog>
  );
}
