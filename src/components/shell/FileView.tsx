import { CircleAlert, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeColumns, type ColumnInfo } from "../../lib/arrow";
import { fetchRows } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import { isMac } from "../../lib/platform";
import type { Tab } from "../../stores/tabs";
import { DataGrid, type DataGridHandle } from "../grid/DataGrid";
import { GoToRow } from "../grid/GoToRow";
import { PagedRowSource, StaticRowSource, type RowSource } from "../grid/rowSource";
import { smallFileBytes, useApp } from "../../stores/app";
import { columnValues, type Filter, type ViewSpec } from "../../lib/view";
import { FilterBar } from "../filters/FilterBar";
import { FilterEditor, type Anchor } from "../filters/FilterEditor";
import { ExcelSettings } from "../import/ExcelSettings";
import { ImportBar } from "../import/ImportBar";
import { ImportSettings } from "../import/ImportSettings";

interface FileViewProps {
  tab: Tab;
  onReopen: (options: Tab["options"]) => void;
  onCancelImport?: () => void;
  onReadDirect?: () => void;
  onViewChange?: (view: ViewSpec) => void;
}

/** The filter editor being shown: a new filter on `column`, or filter `index`. */
interface Editing {
  column: ColumnInfo;
  index?: number;
  anchor: Anchor;
}

const rectAnchor = (r: { x: number; y: number; width: number; height: number }): Anchor => ({
  getBoundingClientRect: () => new DOMRect(r.x, r.y, r.width, r.height),
});

const isCsv = (tab: Tab) => tab.info?.format === "csv" || tab.info?.format === "tsv";

/** The view's rows, else the full dataset (paged from the backend), else the preview. */
function useRowSource(tab: Tab): RowSource | null {
  const dataset = tab.viewState?.dataset ?? tab.info?.dataset ?? undefined;
  const datasetId = dataset?.id;
  const rowCount = dataset?.rowCount;
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

export function FileView({
  tab,
  onReopen,
  onCancelImport,
  onReadDirect,
  onViewChange,
}: FileViewProps) {
  const source = useRowSource(tab);
  const columns = useMemo(() => (tab.preview ? describeColumns(tab.preview) : []), [tab.preview]);
  const view = useMemo(() => tab.view ?? {}, [tab.view]);
  const filters = useMemo(() => view.filters ?? [], [view]);
  const filtered = useMemo(() => new Set(filters.map((f) => f.column)), [filters]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const baseId = tab.info?.dataset?.id;
  const setFilters = (next: Filter[]) => onViewChange?.({ ...view, filters: next });
  const editColumn = editing?.column.name;
  const loadValues = useMemo(
    () =>
      baseId && editColumn
        ? (search: string) =>
            columnValues(baseId, view, editColumn, search, 200, `values:${tab.id}`)
        : undefined,
    [baseId, editColumn, view, tab.id],
  );
  const onHeaderMenu = useCallback(
    (col: number, bounds: { x: number; y: number; width: number; height: number }) => {
      const column = columns[col];
      if (!column) return;
      // Edit the column's filter if it has one, else start a new one.
      const index = filters.findIndex((f) => f.column === column.name);
      setEditing({ column, index: index < 0 ? undefined : index, anchor: rectAnchor(bounds) });
    },
    [columns, filters],
  );
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
        {tab.info?.excel && (
          <ExcelSettings
            info={tab.info.excel}
            onChange={(excel) => onReopen({ ...tab.options, excel })}
          />
        )}
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
      {tab.status === "ready" && onViewChange && columns.length > 0 && (
        <FilterBar
          filters={filters}
          columns={columns}
          onAdd={(column, anchor) => setEditing({ column, anchor })}
          onEdit={(index, anchor) => {
            const column = columns.find((c) => c.name === filters[index]?.column);
            if (column) setEditing({ column, index, anchor });
          }}
          onRemove={(index) => setFilters(filters.filter((_, i) => i !== index))}
          onClear={() => setFilters([])}
        />
      )}
      {tab.viewState?.status === "error" && (
        <div
          role="alert"
          className="mx-3 mt-2 flex items-start gap-2 rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-[12px]"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          <span className="text-fg-muted">Couldn't apply the filters: {tab.viewState.error}</span>
        </div>
      )}
      {editing && (
        <FilterEditor
          key={`${editing.column.name}:${editing.index ?? "new"}`}
          column={editing.column}
          filter={editing.index !== undefined ? filters[editing.index] : undefined}
          anchor={editing.anchor}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          loadValues={loadValues}
          onApply={(f) =>
            setFilters(
              editing.index !== undefined
                ? filters.map((old, i) => (i === editing.index ? f : old))
                : [...filters, f],
            )
          }
          onRemove={
            editing.index !== undefined
              ? () => setFilters(filters.filter((_, i) => i !== editing.index))
              : undefined
          }
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
          <DataGrid
            ref={grid}
            source={source}
            onHeaderMenu={onViewChange ? onHeaderMenu : undefined}
            filteredColumns={filtered}
          />
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
