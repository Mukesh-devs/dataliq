import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeColumns } from "../../lib/arrow";
import { fetchRows } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import { isMac } from "../../lib/platform";
import type { Tab } from "../../stores/tabs";
import { DataGrid, type DataGridHandle } from "../grid/DataGrid";
import { GoToRow } from "../grid/GoToRow";
import { PagedRowSource, StaticRowSource, type RowSource } from "../grid/rowSource";
import { smallFileBytes, useApp } from "../../stores/app";
import { ImportBar } from "../import/ImportBar";
import { ImportSettings } from "../import/ImportSettings";

interface FileViewProps {
  tab: Tab;
  onReopen: (options: Tab["options"]) => void;
  onCancelImport?: () => void;
  onReadDirect?: () => void;
}

const isCsv = (tab: Tab) => tab.info?.format === "csv" || tab.info?.format === "tsv";

/** Full dataset when available (paged from the backend), else the preview. */
function useRowSource(tab: Tab): RowSource | null {
  const datasetId = tab.info?.dataset?.id;
  const rowCount = tab.info?.dataset?.rowCount;
  const source = useMemo(() => {
    if (!tab.preview) return null;
    if (datasetId !== undefined && rowCount !== undefined) {
      return new PagedRowSource({
        rowCount,
        columns: describeColumns(tab.preview),
        fetchPage: (start, count) => fetchRows(datasetId, start, count),
      });
    }
    return new StaticRowSource(tab.preview);
  }, [tab.preview, datasetId, rowCount]);
  useEffect(() => () => source?.dispose(), [source]);
  return source;
}

export function FileView({ tab, onReopen, onCancelImport, onReadDirect }: FileViewProps) {
  const source = useRowSource(tab);
  const settings = useApp((s) => s.settings);
  const grid = useRef<DataGridHandle>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  const showSettings =
    isCsv(tab) || (tab.status === "error" && /\.(csv|tsv|txt|tab)/i.test(tab.path));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "g" && source) {
        e.preventDefault();
        setGoToOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
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
      {tab.import && tab.status === "ready" && (
        <ImportBar
          state={tab.import}
          quiet={(tab.info?.sizeBytes ?? 0) < smallFileBytes(settings)}
          onCancel={() => onCancelImport?.()}
          onReadDirect={() => onReadDirect?.()}
          onRetry={() => onReopen(tab.options)}
        />
      )}
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
      ) : source ? (
        <>
          <DataGrid ref={grid} source={source} />
          <GoToRow
            open={goToOpen}
            onOpenChange={setGoToOpen}
            rowCount={source.rowCount}
            onGo={(row) => grid.current?.scrollToRow(row - 1)}
          />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-fg-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading {tab.title}…
        </div>
      )}
    </div>
  );
}
