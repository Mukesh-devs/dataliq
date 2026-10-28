import * as Popover from "@radix-ui/react-popover";
import { ArrowLeftRight, CircleAlert, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { commonColumns, suggestKeys } from "../../lib/compare";
import type { ColumnMeta } from "../../lib/files";
import type { Anchor } from "../filters/FilterEditor";
import { Button } from "../ui/Button";

/** A file that can be compared (a tab with its full data). */
export interface CompareSide {
  tabId: string;
  title: string;
  columns: ColumnMeta[];
}

interface CompareDialogProps {
  anchor: Anchor;
  /** The tab it was opened from. */
  current: CompareSide;
  /** The other open files. */
  others: CompareSide[];
  onOpenChange: (open: boolean) => void;
  /** Compares `before` with `after` by `keys`; rejects with a message. */
  onCompare: (before: string, after: string, keys: string[]) => Promise<void>;
}

const selectClass =
  "h-7 w-full min-w-0 rounded-[var(--radius)] border border-border bg-bg px-1.5 text-fg outline-none focus:border-accent";

/** Picks the other file and the key columns, then compares. */
export function CompareDialog({
  anchor,
  current,
  others,
  onOpenChange,
  onCompare,
}: CompareDialogProps) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const [otherId, setOtherId] = useState(others[0]?.tabId ?? "");
  const [swapped, setSwapped] = useState(false);
  const other = others.find((o) => o.tabId === otherId);
  const [before, after] = swapped ? [other, current] : [current, other];
  const common = other ? commonColumns(current.columns, other.columns) : [];
  const [keys, setKeys] = useState<string[]>(() =>
    other ? suggestKeys(current.columns, other.columns) : [],
  );
  /** Another file: its own suggested keys. */
  const pickOther = (tabId: string) => {
    setOtherId(tabId);
    const o = others.find((x) => x.tabId === tabId);
    setKeys(o ? suggestKeys(current.columns, o.columns) : []);
  };
  const shownKeys = keys.filter((k) => common.includes(k));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const run = async () => {
    if (!before || !after) return;
    setRunning(true);
    setError(undefined);
    try {
      await onCompare(before.tabId, after.tabId, shownKeys);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Popover.Root open onOpenChange={onOpenChange}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<Anchor>} />
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          aria-label="Compare files"
          className="z-50 flex w-80 flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <h2 className="text-[13px] font-semibold text-fg">Compare files</h2>
          {others.length === 0 ? (
            <p className="text-fg-muted">
              Open the other version of the file in a tab first (once its data is read).
            </p>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              <div className="flex items-end gap-1">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[11px] text-fg-subtle">Before</span>
                  {swapped ? (
                    <OtherSelect others={others} value={otherId} onChange={pickOther} />
                  ) : (
                    <span className="truncate text-fg" title={current.title}>
                      {current.title}
                    </span>
                  )}
                  <span className="mt-1 text-[11px] text-fg-subtle">After</span>
                  {swapped ? (
                    <span className="truncate text-fg" title={current.title}>
                      {current.title}
                    </span>
                  ) : (
                    <OtherSelect others={others} value={otherId} onChange={pickOther} />
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Swap before and after"
                  title="Swap before and after"
                  onClick={() => setSwapped(!swapped)}
                >
                  <ArrowLeftRight className="size-3.5" aria-hidden />
                </Button>
              </div>
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-[11px] text-fg-subtle">
                  Match rows by (key columns)
                </legend>
                {common.length === 0 ? (
                  <p className="text-fg-muted">These files have no column in common.</p>
                ) : (
                  <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                    {common.map((c) => (
                      <label key={c} className="flex items-center gap-1.5 text-fg">
                        <input
                          type="checkbox"
                          checked={shownKeys.includes(c)}
                          onChange={(e) =>
                            setKeys(
                              e.target.checked
                                ? [...shownKeys, c]
                                : shownKeys.filter((k) => k !== c),
                            )
                          }
                        />
                        <span className="truncate font-mono">{c}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              {error && (
                <p role="alert" className="flex items-start gap-1.5 text-fg-muted">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  disabled={running || shownKeys.length === 0}
                >
                  {running && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
                  Compare
                </Button>
              </div>
            </form>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function OtherSelect({
  others,
  value,
  onChange,
}: {
  others: CompareSide[];
  value: string;
  onChange: (tabId: string) => void;
}) {
  return (
    <select
      aria-label="Other file"
      className={selectClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {others.map((o) => (
        <option key={o.tabId} value={o.tabId}>
          {o.title}
        </option>
      ))}
    </select>
  );
}
