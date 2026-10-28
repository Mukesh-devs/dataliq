import {
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Copy,
  LoaderCircle,
  RefreshCw,
  Space,
  SquareDashed,
  TrendingUp,
  Type,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatCount, formatDuration } from "../../lib/format";
import { describeStep, type Step } from "../../lib/recipe";
import {
  KIND_NAMES,
  type QualityReport,
  type QualityWarning,
  type WarningKind,
} from "../../lib/quality";
import { Button, IconButton } from "../ui/Button";

interface QualityPanelProps {
  report?: QualityReport;
  loading: boolean;
  error?: string;
  /** Shows the rows a warning is about (its filters on the view). */
  onShow: (w: QualityWarning) => void;
  /** Shows duplicated rows (a query in the SQL panel); absent without a SQL table. */
  onShowCopies?: () => void;
  /** Adds the warning's fix to the cleaning steps. */
  onFix?: (step: Step) => void;
  onRefresh: () => void;
  onClose: () => void;
}

const ICONS: Record<WarningKind, ReactNode> = {
  empty: <SquareDashed className="size-3.5" aria-hidden />,
  spaces: <Space className="size-3.5" aria-hidden />,
  mixedTypes: <Type className="size-3.5" aria-hidden />,
  dateFormats: <CalendarClock className="size-3.5" aria-hidden />,
  outliers: <TrendingUp className="size-3.5" aria-hidden />,
  duplicates: <Copy className="size-3.5" aria-hidden />,
};

/** Side panel listing a file's data quality warnings. */
export function QualityPanel({
  report,
  loading,
  error,
  onShow,
  onShowCopies,
  onFix,
  onRefresh,
  onClose,
}: QualityPanelProps) {
  const n = report?.warnings.length ?? 0;
  return (
    <aside
      aria-label="Data quality"
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface text-[12px]"
    >
      <header className="flex items-center gap-1 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-fg">Data quality</h2>
          {report && (
            <p className="text-[11px] text-fg-subtle" role="status">
              {n === 0 ? "No problems" : `${n} warning${n === 1 ? "" : "s"}`} in{" "}
              {formatCount(report.rows)} rows · {formatDuration(report.elapsedMs)}
            </p>
          )}
        </div>
        {loading && (
          <LoaderCircle className="size-3.5 animate-spin text-fg-subtle" aria-label="Checking" />
        )}
        <IconButton label="Check again" onClick={onRefresh} className="size-6">
          <RefreshCw className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton label="Close data quality" onClick={onClose} className="size-6">
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </header>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 px-3 py-2 text-fg-muted">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          {error}
        </p>
      )}
      {report && n === 0 && (
        <p className="flex items-start gap-1.5 px-3 py-3 text-fg-muted">
          <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          Every column looks consistent: no stray spaces, mixed types, date formats, outliers,
          mostly empty columns or duplicate rows.
        </p>
      )}
      {report && n > 0 && (
        <ul aria-label="Warnings" className="flex flex-col">
          {report.warnings.map((w, i) => (
            <li key={i} className="flex flex-col gap-1 border-b border-border px-3 py-2">
              <p className="flex items-center gap-1.5 text-fg">
                <span className="text-warning">{ICONS[w.kind]}</span>
                <span className="font-medium">{KIND_NAMES[w.kind]}</span>
                {w.column && (
                  <span className="truncate rounded-[var(--radius-sm)] bg-surface-2 px-1 font-mono text-[11px]">
                    {w.column}
                  </span>
                )}
              </p>
              <p className="text-fg-muted">{w.message}</p>
              <div className="flex flex-wrap gap-1">
                {w.filters.length > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => onShow(w)}>
                    Show {w.rows === 1 ? "the row" : `${formatCount(w.rows)} rows`}
                  </Button>
                )}
                {w.kind === "duplicates" && onShowCopies && (
                  <Button size="sm" variant="secondary" onClick={onShowCopies}>
                    Show copies in SQL
                  </Button>
                )}
                {w.fix && onFix && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onFix(w.fix!)}
                    title={`Adds a cleaning step: ${describeStep(w.fix)}`}
                  >
                    Fix: {describeStep(w.fix)}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
