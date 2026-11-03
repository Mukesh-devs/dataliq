import * as Popover from "@radix-ui/react-popover";
import { LoaderCircle, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ColumnKind } from "../../lib/arrow";
import {
  RULE_COLORS,
  RULE_OPS,
  type CellRule,
  type ColumnFormat,
  type RuleColor,
  type RuleOp,
} from "../../lib/cellFormat";
import { Button, IconButton } from "../ui/Button";
import type { Anchor } from "./FilterEditor";

interface FormatColumnProps {
  column: string;
  kind: ColumnKind;
  format: ColumnFormat | undefined;
  anchor: Anchor;
  onOpenChange: (open: boolean) => void;
  /** The new formatting; none clears it. */
  onChange: (format: ColumnFormat | undefined) => void;
  /** The column's smallest and largest number over the view (for a colour scale). */
  loadRange?: () => Promise<{ min: number; max: number } | null>;
}

const control =
  "h-7 min-w-0 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-[12px] text-fg outline-none focus:border-accent";

const COLOR_NAMES: Record<RuleColor, string> = {
  red: "Red",
  amber: "Amber",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
};

/** A small swatch of a rule colour (from the same tokens the grid uses). */
function Swatch({ color }: { color: RuleColor }) {
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 rounded-sm border border-border"
      style={{ background: `rgb(var(--rule-${color}) / 0.5)` }}
    />
  );
}

/** "Format cells…": highlight rules and a colour scale for one column. */
export function FormatColumn({
  column,
  kind,
  format,
  anchor,
  onOpenChange,
  onChange,
  loadRange,
}: FormatColumnProps) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const numeric = kind === "integer" || kind === "number";
  const [rules, setRules] = useState<CellRule[]>(format?.rules ?? []);
  const [scale, setScale] = useState(format?.scale);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const ops = RULE_OPS.filter(
    (o) => numeric || !o.numeric || kind === "date" || kind === "timestamp",
  );
  const apply = (next: { rules?: CellRule[]; scale?: ColumnFormat["scale"] | null }) => {
    const r = next.rules ?? rules;
    const s = next.scale === null ? undefined : (next.scale ?? scale);
    setRules(r);
    setScale(s);
    // Rules without their value don't apply yet.
    const ready = r.filter((x) => x.op === "empty" || (x.value ?? "").trim() !== "");
    onChange(
      ready.length || s
        ? { ...(ready.length && { rules: ready }), ...(s && { scale: s }) }
        : undefined,
    );
  };
  const setRule = (i: number, rule: CellRule) =>
    apply({ rules: rules.map((r, j) => (j === i ? rule : r)) });
  const toggleScale = async (on: boolean) => {
    if (!on) return apply({ scale: null });
    if (!loadRange) return;
    setLoading(true);
    setError(undefined);
    try {
      const range = await loadRange();
      if (!range) setError("This column has no numbers to scale.");
      else apply({ scale: { ...range, color: scale?.color ?? "green" } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Popover.Root open onOpenChange={onOpenChange}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<Anchor>} />
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={`Format ${column}`}
          className="z-50 flex w-96 flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <h2 className="text-[13px] font-semibold text-fg">Format cells of {column}</h2>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[11px] text-fg-subtle">
              Highlight cells (the first rule that matches)
            </legend>
            {rules.map((r, i) => {
              const noValue = RULE_OPS.find((o) => o.op === r.op)?.noValue;
              return (
                <div key={i} className="flex items-center gap-1">
                  <select
                    aria-label={`Rule ${i + 1}: test`}
                    className={`${control} w-32`}
                    value={r.op}
                    onChange={(e) => setRule(i, { ...r, op: e.target.value as RuleOp })}
                  >
                    {ops.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`Rule ${i + 1}: value`}
                    className={`${control} flex-1`}
                    disabled={noValue}
                    value={noValue ? "" : (r.value ?? "")}
                    inputMode={numeric ? "decimal" : undefined}
                    onChange={(e) => setRule(i, { ...r, value: e.target.value })}
                  />
                  <select
                    aria-label={`Rule ${i + 1}: colour`}
                    className={`${control} w-24`}
                    value={r.color}
                    onChange={(e) => setRule(i, { ...r, color: e.target.value as RuleColor })}
                  >
                    {RULE_COLORS.map((c) => (
                      <option key={c} value={c}>
                        {COLOR_NAMES[c]}
                      </option>
                    ))}
                  </select>
                  <Swatch color={r.color} />
                  <IconButton
                    label={`Remove rule ${i + 1}`}
                    className="size-6 shrink-0"
                    onClick={() => apply({ rules: rules.filter((_, j) => j !== i) })}
                  >
                    <X className="size-3.5" aria-hidden />
                  </IconButton>
                </div>
              );
            })}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() =>
                apply({
                  rules: [
                    ...rules,
                    {
                      op: numeric ? "gt" : "contains",
                      value: "",
                      color: RULE_COLORS[rules.length % RULE_COLORS.length]!,
                    },
                  ],
                })
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add a rule
            </Button>
          </fieldset>
          {numeric && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-[11px] text-fg-subtle">Colour scale</legend>
              <label className="flex items-center gap-1.5 text-fg">
                <input
                  type="checkbox"
                  checked={!!scale}
                  disabled={loading}
                  onChange={(e) => void toggleScale(e.target.checked)}
                />
                Shade every number by its size
                {loading && <LoaderCircle className="size-3 animate-spin" aria-hidden />}
              </label>
              {scale && (
                <div className="flex items-center gap-2 pl-5">
                  <select
                    aria-label="Scale colour"
                    className={`${control} w-28`}
                    value={scale.color}
                    onChange={(e) =>
                      apply({ scale: { ...scale, color: e.target.value as RuleColor } })
                    }
                  >
                    {RULE_COLORS.map((c) => (
                      <option key={c} value={c}>
                        {COLOR_NAMES[c]}
                      </option>
                    ))}
                  </select>
                  <span className="tabular text-fg-subtle">
                    {scale.min.toLocaleString("en-US")} → {scale.max.toLocaleString("en-US")}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void toggleScale(true)}>
                    Refresh range
                  </Button>
                </div>
              )}
              {error && <p className="pl-5 text-fg-muted">{error}</p>}
            </fieldset>
          )}
          <div className="flex justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={rules.length === 0 && !scale}
              onClick={() => {
                setRules([]);
                setScale(undefined);
                onChange(undefined);
              }}
            >
              Clear formatting
            </Button>
            <Button size="sm" variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
