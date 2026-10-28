import { Info } from "lucide-react";
import { compareNotes, type CompareInfo, type RowStatus } from "../../lib/compare";
import { formatCount, formatDuration } from "../../lib/format";

interface CompareBarProps {
  compare: CompareInfo;
  /** The status the rows are filtered to, if any. */
  shown?: RowStatus;
  onShow: (status: RowStatus | undefined) => void;
}

const KINDS: { status: RowStatus; label: string; dot: string }[] = [
  { status: "added", label: "added", dot: "bg-[var(--diff-added-mark)]" },
  { status: "removed", label: "removed", dot: "bg-[var(--diff-removed-mark)]" },
  { status: "changed", label: "changed", dot: "bg-[var(--diff-changed-mark)]" },
];

/** A comparison's counts (each one filters the rows) and what it couldn't match. */
export function CompareBar({ compare: c, shown, onShow }: CompareBarProps) {
  const notes = compareNotes(c);
  const counts: Record<RowStatus, number> = {
    added: c.added,
    removed: c.removed,
    changed: c.changed,
  };
  return (
    <section
      aria-label="Comparison"
      className="flex shrink-0 flex-col gap-1 border-b border-border bg-surface px-3 py-2 text-[12px]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-fg-muted">
          {formatCount(c.leftRows)} → {formatCount(c.rightRows)} rows, matched by{" "}
          {c.keys.map((k) => `“${k}”`).join(", ")}:
        </span>
        <div role="group" aria-label="Show rows" className="flex items-center gap-1">
          {KINDS.map(({ status, label, dot }) => (
            <button
              key={status}
              type="button"
              aria-pressed={shown === status}
              onClick={() => onShow(shown === status ? undefined : status)}
              className={`flex h-6 items-center gap-1.5 rounded-[var(--radius)] border px-2 tabular ${
                shown === status
                  ? "border-accent bg-accent-soft text-fg"
                  : "border-border text-fg hover:bg-hover"
              }`}
            >
              <span className={`size-2 rounded-full ${dot}`} aria-hidden />
              {formatCount(counts[status])} {label}
            </button>
          ))}
        </div>
        <span className="text-fg-muted tabular">{formatCount(c.same)} the same</span>
        {c.changes.length > 0 && (
          <span className="text-fg-subtle">
            Changed: {c.changes.map((x) => `${x.name} ${formatCount(x.rows)}`).join(" · ")}
          </span>
        )}
        <span className="ml-auto text-fg-subtle tabular">{formatDuration(c.elapsedMs)}</span>
      </div>
      {notes.map((n) => (
        <p key={n} className="flex items-start gap-1.5 text-fg-muted">
          <Info className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          {n}
        </p>
      ))}
    </section>
  );
}
