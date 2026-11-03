import { Plus, X } from "lucide-react";
import { useState } from "react";
import type { ColumnMeta } from "../../lib/files";
import { AGGS, isNumericType, type Agg, type Measure, type PivotSpec } from "../../lib/tools";
import { Button, IconButton } from "../ui/Button";
import { ToolDialog, ViewToggle, fieldClass, labelClass } from "./ToolDialog";

/** Names of id columns (not worth summing). */
const ID_LIKE = /(^|[_\s-])(id|key|no|number|code)$|^id([_\s-]|$)/i;

interface PivotDialogProps {
  columns: ColumnMeta[];
  /** The view filters rows: offer to use only those. */
  hasView: boolean;
  /** Group by this column at first (from a column menu). */
  initialGroup?: string;
  onClose: () => void;
  onRun: (spec: PivotSpec, withView: boolean) => Promise<void>;
}

/** Group by / pivot: rows per combination of columns, with counts, sums, averages, … */
export function PivotDialog({ columns, hasView, initialGroup, onClose, onRun }: PivotDialogProps) {
  const [groups, setGroups] = useState<string[]>(initialGroup ? [initialGroup] : []);
  // The first number column that isn't an id, to sum.
  const numbers = columns.filter((c) => isNumericType(c.type));
  const firstNumber = (numbers.find((c) => !ID_LIKE.test(c.name)) ?? numbers[0])?.name;
  const [measures, setMeasures] = useState<Measure[]>(() => [
    { agg: "count" },
    ...(firstNumber && firstNumber !== initialGroup
      ? [{ agg: "sum" as Agg, column: firstNumber }]
      : []),
  ]);
  const [pivotOn, setPivotOn] = useState("");
  const [withView, setWithView] = useState(hasView);
  const typeOf = new Map(columns.map((c) => [c.name, c.type]));
  const toggleGroup = (name: string, on: boolean) =>
    setGroups(
      on
        ? columns.map((c) => c.name).filter((c) => c === name || groups.includes(c))
        : groups.filter((g) => g !== name),
    );
  const setMeasure = (i: number, m: Measure) =>
    setMeasures(measures.map((x, j) => (j === i ? m : x)));
  const invalid = measures.find(
    (m) =>
      m.column &&
      AGGS.find((a) => a.agg === m.agg)?.numeric &&
      !isNumericType(typeOf.get(m.column) ?? ""),
  );
  return (
    <ToolDialog
      title="Group by / pivot"
      runLabel="Group"
      width="w-[30rem]"
      onClose={onClose}
      blocked={
        measures.some((m) => m.agg !== "count" && !m.column)
          ? "Choose a column for each value"
          : invalid
            ? `${AGGS.find((a) => a.agg === invalid.agg)!.label} needs a number column`
            : pivotOn && groups.includes(pivotOn)
              ? "Spread by a column that isn't a row group"
              : undefined
      }
      onRun={() => onRun({ groups, measures, pivotOn: pivotOn || undefined }, withView)}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className={`mb-1 ${labelClass}`}>One row per combination of</legend>
        <div className="grid max-h-36 grid-cols-2 gap-x-3 gap-y-0.5 overflow-y-auto">
          {columns.map((c) => (
            <label
              key={c.name}
              className="flex min-w-0 items-center gap-1.5 text-fg"
              title={c.name}
            >
              <input
                type="checkbox"
                checked={groups.includes(c.name)}
                onChange={(e) => toggleGroup(c.name, e.target.checked)}
              />
              <span className="truncate">{c.name}</span>
            </label>
          ))}
        </div>
        {groups.length === 0 && <p className="text-fg-subtle">None: one row of totals.</p>}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className={`mb-1 ${labelClass}`}>Values</legend>
        {measures.map((m, i) => (
          <div key={i} className="flex items-center gap-1">
            <select
              aria-label={`Value ${i + 1}: calculation`}
              className={fieldClass}
              value={m.agg}
              onChange={(e) => setMeasure(i, { ...m, agg: e.target.value as Agg })}
            >
              {AGGS.map((a) => (
                <option key={a.agg} value={a.agg}>
                  {a.label}
                </option>
              ))}
            </select>
            <span className="text-fg-subtle">of</span>
            <select
              aria-label={`Value ${i + 1}: column`}
              className={fieldClass}
              value={m.column ?? ""}
              onChange={(e) => setMeasure(i, { ...m, column: e.target.value || undefined })}
            >
              {m.agg === "count" && <option value="">rows</option>}
              {m.agg !== "count" && !m.column && <option value="">Choose a column</option>}
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <IconButton
              label={`Remove value ${i + 1}`}
              className="size-6 shrink-0"
              onClick={() => setMeasures(measures.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" aria-hidden />
            </IconButton>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => setMeasures([...measures, { agg: "count" }])}
        >
          <Plus className="size-3.5" aria-hidden /> Add a value
        </Button>
      </fieldset>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Spread across columns by (optional)</span>
        <select className={fieldClass} value={pivotOn} onChange={(e) => setPivotOn(e.target.value)}>
          <option value="">— no, one column per value —</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {hasView && <ViewToggle value={withView} onChange={setWithView} />}
    </ToolDialog>
  );
}
