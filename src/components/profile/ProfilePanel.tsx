import { CircleAlert, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { formatCount } from "../../lib/format";
import type { ColumnProfile } from "../../lib/view";
import { IconButton } from "../ui/Button";
import { formatEdge, formatPercent, formatStat } from "./format";

interface ProfilePanelProps {
  /** Display name of the column. */
  title: string;
  profile?: ColumnProfile;
  loading?: boolean;
  error?: string;
  onClose: () => void;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="tabular truncate text-right text-fg" title={String(children)}>
        {children}
      </dd>
    </>
  );
}

/** Side panel with a column's statistics over the current view. */
export function ProfilePanel({ title, profile, loading, error, onClose }: ProfilePanelProps) {
  const p = profile;
  const bins = p?.histogram ?? [];
  const maxBin = Math.max(1, ...bins.map((b) => b.count));
  const range = bins.length ? bins[bins.length - 1]!.hi - bins[0]!.lo : 0;
  return (
    <aside
      aria-label={`Profile of ${title}`}
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface text-[12px]"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold text-fg" title={title}>
            {title}
          </h2>
          {p && <p className="font-mono text-[11px] text-fg-subtle">{p.type}</p>}
        </div>
        {loading && (
          <LoaderCircle className="size-3.5 animate-spin text-fg-subtle" aria-label="Loading" />
        )}
        <IconButton label="Close profile" onClick={onClose} className="size-6">
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </header>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 px-3 py-2 text-fg-muted">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          {error}
        </p>
      )}
      {p && (
        <div className="flex flex-col gap-3 px-3 py-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <Stat label="Rows">{formatCount(p.rows)}</Stat>
            <Stat label="Nulls">
              {formatCount(p.nulls)} ({formatPercent(p.nulls, p.rows)})
            </Stat>
            {p.distinct !== null && (
              <Stat label="Distinct">
                {p.distinctApprox ? "≈ " : ""}
                {formatCount(p.distinct)}
              </Stat>
            )}
            {p.min !== null && <Stat label="Min">{p.min}</Stat>}
            {p.max !== null && <Stat label="Max">{p.max}</Stat>}
            {p.mean !== null && <Stat label="Mean">{formatStat(p.mean)}</Stat>}
            {p.stddev !== null && <Stat label="Std dev">{formatStat(p.stddev)}</Stat>}
          </dl>
          {bins.length > 0 && (
            <section aria-label="Histogram">
              <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
                Distribution
              </h3>
              <div className="flex h-20 items-end gap-px" role="list">
                {bins.map((b, i) => (
                  <div
                    key={i}
                    role="listitem"
                    className="min-h-px flex-1 rounded-t-sm bg-accent/70"
                    style={{ height: `${(b.count / maxBin) * 100}%` }}
                    title={`${formatEdge(b.lo, p.kind, range)} – ${formatEdge(b.hi, p.kind, range)}: ${formatCount(b.count)}`}
                    aria-label={`${formatEdge(b.lo, p.kind, range)} to ${formatEdge(b.hi, p.kind, range)}: ${formatCount(b.count)}`}
                  />
                ))}
              </div>
              <div className="mt-0.5 flex justify-between text-[11px] text-fg-subtle tabular">
                <span>{formatEdge(bins[0]!.lo, p.kind, range)}</span>
                <span>{formatEdge(bins[bins.length - 1]!.hi, p.kind, range)}</span>
              </div>
            </section>
          )}
          {p.top.length > 0 && (
            <section aria-label="Top values">
              <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
                Most common
              </h3>
              <ul className="flex flex-col gap-0.5">
                {p.top.map((v) => (
                  <li
                    key={v.value ?? "\u0000null"}
                    className="relative flex items-center gap-2 px-1 py-0.5"
                  >
                    <span
                      className="absolute inset-y-0 left-0 rounded-sm bg-accent-soft"
                      style={{ width: `${(v.count / Math.max(1, p.rows)) * 100}%` }}
                      aria-hidden
                    />
                    <span
                      className={
                        v.value === null
                          ? "relative flex-1 truncate italic text-fg-subtle"
                          : "relative flex-1 truncate text-fg"
                      }
                    >
                      {v.value === null ? "null" : v.value === "" ? '""' : v.value}
                    </span>
                    <span className="relative tabular text-fg-muted">
                      {formatCount(v.count)} · {formatPercent(v.count, p.rows)}
                    </span>
                  </li>
                ))}
              </ul>
              {p.topTruncated && (
                <p className="mt-1 text-[11px] text-fg-subtle">Showing the 10 most common values</p>
              )}
            </section>
          )}
          <p className="text-[11px] text-fg-subtle">
            Over the rows in view ·{" "}
            {p.elapsedMs < 1000 ? `${p.elapsedMs} ms` : `${(p.elapsedMs / 1000).toFixed(1)} s`}
          </p>
        </div>
      )}
    </aside>
  );
}

/** The right panel before a column is chosen: pick one to profile. */
export function ProfilePicker({
  columns,
  onPick,
  onClose,
}: {
  columns: { name: string; label: string }[];
  onPick: (column: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Column profile"
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface text-[12px]"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 text-[13px] font-semibold text-fg">Column profile</h2>
        <IconButton label="Close profile" onClick={onClose} className="size-6">
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </header>
      <p className="px-3 pt-2 text-fg-muted">Choose a column:</p>
      <ul className="flex flex-col p-1">
        {columns.map((c) => (
          <li key={c.name}>
            <button
              type="button"
              onClick={() => onPick(c.name)}
              className="w-full truncate rounded-[var(--radius)] px-2 py-1 text-left text-fg hover:bg-hover"
            >
              {c.label}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
