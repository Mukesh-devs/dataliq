import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  LoaderCircle,
  Redo2,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { cloneElement, useId, useState, type ReactElement } from "react";
import type { ColumnInfo } from "../../lib/arrow";
import { formatCount } from "../../lib/format";
import { modKey } from "../../lib/platform";
import {
  STEP_NAMES,
  TYPE_NAMES,
  describeStep,
  isEnabled,
  type Case,
  type NewType,
  type RecipeStep,
  type Step,
  type StepOp,
  type StepOutcome,
} from "../../lib/recipe";
import type { Filter } from "../../lib/view";
import { Button, IconButton } from "../ui/Button";

interface RecipePanelProps {
  steps: RecipeStep[];
  /** What happened to each step (absent while they are being applied). */
  outcomes?: StepOutcome[];
  running: boolean;
  /** The recipe couldn't be applied at all. */
  error?: string;
  /** The columns after the last step: what a new step works on. */
  columns: ColumnInfo[];
  /** Column a new step starts on (from the column menu). */
  column?: string;
  canUndo: boolean;
  canRedo: boolean;
  onChange: (steps: RecipeStep[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
}

const control =
  "h-7 w-full min-w-0 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-[12px] text-fg outline-none focus:border-accent";

const OPS = Object.keys(STEP_NAMES) as StepOp[];
/** Steps that work on one column. */
const ROW_OPS = new Set<StepOp>(["removeDuplicates", "calculate"]);

/** Side panel listing the tab's cleaning steps, with a form to add one. */
export function RecipePanel({
  steps,
  outcomes,
  running,
  error,
  columns,
  column,
  canUndo,
  canRedo,
  onChange,
  onUndo,
  onRedo,
  onClose,
}: RecipePanelProps) {
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    onChange(next);
  };
  return (
    <aside
      aria-label="Cleaning steps"
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface text-[12px]"
    >
      <header className="flex items-center gap-1 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-fg">Clean</h2>
          <p className="text-[11px] text-fg-subtle">The file itself is never changed.</p>
        </div>
        {running && (
          <LoaderCircle className="size-3.5 animate-spin text-fg-subtle" aria-label="Applying" />
        )}
        <IconButton
          label={`Undo (${modKey}+Z)`}
          onClick={onUndo}
          disabled={!canUndo}
          className="size-6 disabled:opacity-40"
        >
          <Undo2 className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton
          label={`Redo (${modKey}+Shift+Z)`}
          onClick={onRedo}
          disabled={!canRedo}
          className="size-6 disabled:opacity-40"
        >
          <Redo2 className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton label="Close cleaning steps" onClick={onClose} className="size-6">
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </header>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 px-3 py-2 text-fg-muted">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          {error}
        </p>
      )}
      {steps.length === 0 ? (
        <p className="px-3 py-3 text-fg-muted">
          No steps yet. Add one below, or pick “Clean column…” from a column’s menu.
        </p>
      ) : (
        <ol aria-label="Steps" className="flex flex-col border-b border-border">
          {steps.map((s, i) => {
            const o = outcomes?.[i];
            const on = isEnabled(s);
            return (
              <li
                key={i}
                className="group flex items-start gap-2 border-b border-border px-3 py-2 last:border-b-0"
              >
                <input
                  type="checkbox"
                  aria-label={`Apply step ${i + 1}`}
                  checked={on}
                  onChange={(e) =>
                    onChange(
                      steps.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)),
                    )
                  }
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <div className="min-w-0 flex-1">
                  <p className={on ? "text-fg" : "text-fg-subtle line-through"}>
                    <span className="text-fg-subtle tabular">{i + 1}. </span>
                    {describeStep(s)}
                  </p>
                  {o?.error && (
                    <p role="alert" className="mt-0.5 flex items-start gap-1 text-danger">
                      <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                      <span className="text-fg-muted">{o.error}</span>
                    </p>
                  )}
                  {o && !o.error && (o.failed ?? 0) > 0 && (
                    <p className="mt-0.5 flex items-start gap-1 text-fg-muted">
                      <TriangleAlert className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
                      {formatCount(o.failed!)} value{o.failed === 1 ? "" : "s"} couldn’t be
                      converted (now empty)
                    </p>
                  )}
                  {o?.skipped && on && (
                    <p className="mt-0.5 text-fg-subtle">Not applied: an earlier step fails</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  <IconButton
                    label={`Move step ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    className="size-5 disabled:opacity-30"
                  >
                    <ArrowUp className="size-3" aria-hidden />
                  </IconButton>
                  <IconButton
                    label={`Move step ${i + 1} down`}
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                    className="size-5 disabled:opacity-30"
                  >
                    <ArrowDown className="size-3" aria-hidden />
                  </IconButton>
                  <IconButton
                    label={`Remove step ${i + 1}`}
                    onClick={() => onChange(steps.filter((_, j) => j !== i))}
                    className="size-5"
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <StepForm
        // A new column from the menu starts a fresh form.
        key={column ?? ""}
        columns={columns}
        column={column}
        onAdd={(s) => onChange([...steps, s])}
      />
      {steps.length > 0 && (
        <div className="px-3 pb-3">
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>
            Remove all steps
          </Button>
        </div>
      )}
    </aside>
  );
}

/** A labelled control (named by its label only, not by its options' text). */
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={id} className="text-[11px] text-fg-subtle">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}

type RowTest = "empty" | "isNull" | "equals" | "contains" | "lt" | "gt";
const ROW_TESTS: [RowTest, string][] = [
  ["empty", "is empty"],
  ["isNull", "is missing (null)"],
  ["equals", "equals"],
  ["contains", "contains"],
  ["lt", "is less than"],
  ["gt", "is greater than"],
];
const NUMERIC = new Set(["integer", "number"]);

/** Builds one step from its fields. */
function StepForm({
  columns,
  column,
  onAdd,
}: {
  columns: ColumnInfo[];
  column?: string;
  onAdd: (step: Step) => void;
}) {
  const [op, setOp] = useState<StepOp>("trim");
  const [col, setCol] = useState(column ?? columns[0]?.name ?? "");
  const [text, setText] = useState("");
  const [other, setOther] = useState("");
  const [to, setTo] = useState<NewType>("number");
  const [letterCase, setLetterCase] = useState<Case>("title");
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [keep, setKeep] = useState(false);
  const [test, setTest] = useState<RowTest>("empty");
  const [dedupeAll, setDedupeAll] = useState(true);
  const info = columns.find((c) => c.name === col);
  const names = other
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  const build = (): Step | null => {
    if (!ROW_OPS.has(op) && !info) return null;
    switch (op) {
      case "rename":
        return text.trim() ? { op, column: col, to: text.trim() } : null;
      case "changeType":
        return { op, column: col, to, format: text.trim() || undefined };
      case "trim":
        return { op, column: col };
      case "changeCase":
        return { op, column: col, case: letterCase };
      case "replace":
        return text
          ? { op, column: col, find: text, replace: other, regex, caseSensitive: matchCase }
          : null;
      case "split":
        return text && names.length > 0
          ? { op, column: col, delimiter: text, into: names, keep }
          : null;
      case "fillEmpty":
        return text ? { op, column: col, value: text } : null;
      case "removeDuplicates":
        return dedupeAll ? { op } : info ? { op, columns: [col] } : null;
      case "removeRows": {
        const needs = test !== "empty" && test !== "isNull";
        if (needs && !text) return null;
        const numeric = NUMERIC.has(info!.kind);
        const value = numeric && text.trim() !== "" && !isNaN(Number(text)) ? Number(text) : text;
        const filter: Filter =
          test === "empty" || test === "isNull"
            ? { column: col, op: test }
            : test === "contains"
              ? { column: col, op: test, value: text }
              : { column: col, op: test, value };
        return { op, filter };
      }
      case "calculate":
        return text.trim() && other.trim()
          ? { op, name: text.trim(), expression: other.trim() }
          : null;
    }
  };
  const step = build();
  const pick = (next: StepOp) => {
    setOp(next);
    setText("");
    setOther(next === "split" && col ? `${col} 1, ${col} 2` : "");
  };

  return (
    <form
      aria-label="Add a step"
      className="flex flex-col gap-2 px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!step) return;
        onAdd(step);
        setText("");
        if (op !== "split") setOther("");
      }}
    >
      <h3 className="text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
        Add a step
      </h3>
      <Field label="Step">
        <select className={control} value={op} onChange={(e) => pick(e.target.value as StepOp)}>
          {OPS.map((o) => (
            <option key={o} value={o}>
              {STEP_NAMES[o]}
            </option>
          ))}
        </select>
      </Field>
      {op === "removeDuplicates" && (
        <Field label="Rows are duplicates when">
          <select
            className={control}
            value={dedupeAll ? "" : col}
            onChange={(e) => {
              setDedupeAll(e.target.value === "");
              if (e.target.value) setCol(e.target.value);
            }}
          >
            <option value="">every column is equal</option>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} is equal
              </option>
            ))}
          </select>
        </Field>
      )}
      {!ROW_OPS.has(op) && (
        <Field label="Column">
          <select
            className={control}
            value={col}
            onChange={(e) => {
              setCol(e.target.value);
              if (op === "split") setOther(`${e.target.value} 1, ${e.target.value} 2`);
            }}
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {op === "rename" && (
        <Field label="New name">
          <input className={control} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      {op === "changeType" && (
        <>
          <Field label="To">
            <select
              className={control}
              value={to}
              onChange={(e) => setTo(e.target.value as NewType)}
            >
              {(Object.keys(TYPE_NAMES) as NewType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_NAMES[t]}
                </option>
              ))}
            </select>
          </Field>
          {(to === "date" || to === "timestamp") && info?.kind === "text" && (
            <Field label="Date format (optional)">
              <input
                className={control}
                placeholder="%d/%m/%Y"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          )}
        </>
      )}
      {op === "changeCase" && (
        <Field label="Case">
          <select
            className={control}
            value={letterCase}
            onChange={(e) => setLetterCase(e.target.value as Case)}
          >
            <option value="title">Title Case</option>
            <option value="upper">UPPER CASE</option>
            <option value="lower">lower case</option>
          </select>
        </Field>
      )}
      {op === "replace" && (
        <>
          <Field label="Find">
            <input className={control} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="Replace with">
            <input className={control} value={other} onChange={(e) => setOther(e.target.value)} />
          </Field>
          <div className="flex gap-3 text-fg-muted">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
              Pattern (regex)
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
              />
              Match case
            </label>
          </div>
        </>
      )}
      {op === "split" && (
        <>
          <Field label="At">
            <input
              className={control}
              placeholder="e.g. , or a space"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <Field label="Into new columns (comma-separated)">
            <input className={control} value={other} onChange={(e) => setOther(e.target.value)} />
          </Field>
          <label className="flex items-center gap-1 text-fg-muted">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            Keep the original column
          </label>
        </>
      )}
      {op === "fillEmpty" && (
        <Field label="With">
          <input className={control} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      {op === "removeRows" && (
        <>
          <Field label="Where the value">
            <select
              className={control}
              value={test}
              onChange={(e) => setTest(e.target.value as RowTest)}
            >
              {ROW_TESTS.map(([t, name]) => (
                <option key={t} value={t}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          {test !== "empty" && test !== "isNull" && (
            <Field label="Value">
              <input className={control} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
        </>
      )}
      {op === "calculate" && (
        <>
          <Field label="New column">
            <input className={control} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="Expression (DuckDB SQL)">
            <input
              className={`${control} font-mono`}
              placeholder="price * quantity"
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
          </Field>
        </>
      )}
      <div>
        <Button type="submit" size="sm" variant="primary" disabled={!step}>
          Add step
        </Button>
      </div>
    </form>
  );
}
