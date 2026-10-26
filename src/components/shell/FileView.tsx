import { CircleAlert, LoaderCircle } from "lucide-react";
import { formatBytes } from "../../lib/format";
import type { Tab } from "../../stores/tabs";
import { ImportSettings } from "../import/ImportSettings";
import { PreviewTable } from "../preview/PreviewTable";

interface FileViewProps {
  tab: Tab;
  onReopen: (options: Tab["options"]) => void;
}

const isCsv = (tab: Tab) => tab.info?.format === "csv" || tab.info?.format === "tsv";

export function FileView({ tab, onReopen }: FileViewProps) {
  const showSettings =
    isCsv(tab) || (tab.status === "error" && /\.(csv|tsv|txt|tab)/i.test(tab.path));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate font-medium text-fg" title={tab.path}>
          {tab.title}
        </span>
        {tab.info && (
          <span className="rounded-[var(--radius-sm)] bg-surface-2 px-1.5 py-px text-[11px] text-fg-muted uppercase">
            {tab.info.format}
            {tab.info.compression !== "none" && ` · ${tab.info.compression}`} ·{" "}
            {formatBytes(tab.info.sizeBytes)}
          </span>
        )}
        <div className="flex-1" />
        {showSettings && (
          <ImportSettings
            options={tab.options.csv ?? {}}
            sniffed={tab.info?.sniffed ?? null}
            onApply={(csv) => onReopen({ ...tab.options, csv })}
          />
        )}
      </div>
      {tab.status === "error" ? (
        <div
          role="alert"
          className="m-6 flex max-w-2xl items-start gap-3 rounded-[var(--radius-lg)] border border-border bg-surface p-4"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-medium text-fg">Couldn't open {tab.title}</p>
            <p className="text-fg-muted">{tab.error}</p>
          </div>
        </div>
      ) : tab.preview ? (
        <PreviewTable table={tab.preview} />
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-fg-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading {tab.title}…
        </div>
      )}
    </div>
  );
}
