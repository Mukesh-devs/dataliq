import { CircleAlert, Download, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeColumns, type ColumnInfo } from "../../lib/arrow";
import { fetchRows } from "../../lib/files";
import { formatBytes, formatCount, formatValue } from "../../lib/format";
import { COPY_FORMATS, formatRows, tableName, type CopyFormat } from "../../lib/copyAs";
import { isMac, modKey } from "../../lib/platform";
import { useRegisterCommands, type Command } from "../../stores/commands";
import { useNotice } from "../../stores/notice";
import { useTabs } from "../../stores/tabs";
import type { Tab } from "../../stores/tabs";
import { DataGrid, type DataGridHandle } from "../grid/DataGrid";
import { GoToRow } from "../grid/GoToRow";
import { MAX_COPY_ROWS, readRows } from "../grid/readRows";
import { NOT_LOADED, PagedRowSource, StaticRowSource, type RowSource } from "../grid/rowSource";
import { smallFileBytes, useApp } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import {
  columnHistograms,
  columnProfile,
  columnValues,
  statsSpec,
  toggleSort,
  viewSql,
  type Bin,
  type ColumnProfile,
  type Filter,
  type SortKey,
  type ViewSpec,
} from "../../lib/view";
import { ProfilePanel, ProfilePicker } from "../profile/ProfilePanel";
import { CellMenu, type CellMenuActions } from "../grid/CellMenu";
import { filterForValue } from "../../lib/cellFilter";
import { useLayout } from "../../stores/layout";
import { useExport } from "../../stores/export";
import { Button } from "../ui/Button";
import { ColumnMenu } from "../filters/ColumnMenu";
import { RenameColumn } from "../filters/RenameColumn";
import {
  label,
  reconcile,
  rename,
  setHidden,
  setPinned,
  showAll,
  visible,
  type ColumnLayout,
} from "../../lib/layout";
import { FilterBar } from "../filters/FilterBar";
import { SearchBox } from "../filters/SearchBox";
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
  onLayoutChange?: (layout: ColumnLayout) => void;
  /** Reads the file again, keeping filters and layout. */
  onReload?: () => void;
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

const CHART_KINDS = new Set(["integer", "number", "date", "timestamp", "boolean"]);
const NO_CHARTS: ReadonlyMap<string, Bin[]> = new Map();

/** Where editors opened from the palette appear: over the grid's top left. */
const gridAnchor = (): Anchor => ({
  getBoundingClientRect: () => {
    const r = document.querySelector("[data-testid='data-grid']")?.getBoundingClientRect();
    return new DOMRect((r?.x ?? 0) + 60, r?.y ?? 0, 1, 32);
  },
});

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

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
  onLayoutChange,
  onReload,
}: FileViewProps) {
  const source = useRowSource(tab);
  const columns = useMemo(() => (tab.preview ? describeColumns(tab.preview) : []), [tab.preview]);
  const view = useMemo(() => tab.view ?? {}, [tab.view]);
  const filters = useMemo(() => view.filters ?? [], [view]);
  const filtered = useMemo(() => new Set(filters.map((f) => f.column)), [filters]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<{ column: ColumnInfo; anchor: Anchor } | null>(null);
  const [renaming, setRenaming] = useState<{ column: string; anchor: Anchor } | null>(null);
  const [profiled, setProfiled] = useState<string | null>(null);
  // The right panel; shared by all tabs (each tab keeps its own column).
  const profileOpen = useLayout((s) => s.profile);
  const setProfileOpen = useLayout((s) => s.setProfile);
  const showProfile = useCallback(
    (column: string) => {
      setProfiled(column);
      setProfileOpen(true);
    },
    [setProfileOpen],
  );
  const [cellMenu, setCellMenu] = useState<{
    column: string;
    row: number;
    anchor: Anchor;
  } | null>(null);
  // The last profile result and what it was computed for (column + view).
  const [profile, setProfile] = useState<{
    key: string;
    column: string;
    data?: ColumnProfile;
    error?: string;
  } | null>(null);
  const layout = useMemo(
    () =>
      reconcile(
        tab.layout,
        columns.map((c) => c.name),
      ),
    [tab.layout, columns],
  );
  const sort = useMemo(() => view.sort ?? [], [view]);
  const setSort = (next: SortKey[]) => onViewChange?.({ ...view, sort: next });
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
  // The open profile follows the view's filters and search (not its sort).
  const statsKey = JSON.stringify(statsSpec(view));
  const profileKey = `${profiled}\u0000${baseId}\u0000${statsKey}`;
  useEffect(() => {
    if (!profileOpen || !profiled || !baseId) return;
    let alive = true;
    const key = `${profiled}\u0000${baseId}\u0000${statsKey}`;
    columnProfile(baseId, JSON.parse(statsKey) as ViewSpec, profiled, `profile:${tab.id}`)
      .then((data) => alive && setProfile({ key, column: profiled, data }))
      .catch((e: unknown) => {
        if (!alive || (e as { kind?: string }).kind === "cancelled") return;
        setProfile({ key, column: profiled, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [profileOpen, profiled, baseId, statsKey, tab.id]);

  // Header histograms for every number, date and boolean column, following
  // the view's filters and search. The previous ones stay up while new ones load.
  const headerCharts = useSettings((s) => s.headerCharts);
  const chartColumns = useMemo(
    () => columns.filter((c) => CHART_KINDS.has(c.kind)).map((c) => c.name),
    [columns],
  );
  const chartsWanted = headerCharts && baseId !== undefined && chartColumns.length > 0;
  const [charts, setCharts] = useState<ReadonlyMap<string, Bin[]>>(NO_CHARTS);
  useEffect(() => {
    if (!chartsWanted || !baseId) return;
    let alive = true;
    columnHistograms(baseId, JSON.parse(statsKey) as ViewSpec, chartColumns, `charts:${tab.id}`)
      .then((list) => alive && setCharts(new Map(list.map((h) => [h.column, h.bins]))))
      // Headers simply go without charts (cancelled, or the view failed).
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chartsWanted, baseId, statsKey, chartColumns, tab.id]);

  const onHeaderMenu = useCallback(
    (name: string, bounds: { x: number; y: number; width: number; height: number }) => {
      const column = columns.find((c) => c.name === name);
      if (column) setMenu({ column, anchor: rectAnchor(bounds) });
    },
    [columns],
  );
  /** Edit the column's filter if it has one, else start a new one. */
  const filterColumn = (column: ColumnInfo, anchor: Anchor) => {
    const index = filters.findIndex((f) => f.column === column.name);
    setEditing({ column, index: index < 0 ? undefined : index, anchor });
  };
  const viewSort = view.sort;
  const onHeaderClick = useCallback(
    (name: string, add: boolean) =>
      onViewChange?.({ ...view, sort: toggleSort(viewSort ?? [], name, add) }),
    [onViewChange, view, viewSort],
  );
  const settings = useApp((s) => s.settings);
  const grid = useRef<DataGridHandle>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  const notice = useNotice((s) => s.show);
  const cancelView = useTabs((s) => s.cancelView);

  /** Copies the selected cells (shown columns, display names) as `format`. */
  const copySelection = useCallback(
    async (format: CopyFormat, opts: { headers?: boolean } = {}) => {
      const sel = source && grid.current?.selected(MAX_COPY_ROWS);
      if (!source || !sel || sel.rows.length === 0 || sel.columns.length === 0) {
        notice("Select some cells, rows or columns to copy first");
        return;
      }
      const cut = sel.rows.length > MAX_COPY_ROWS;
      const rows = cut ? sel.rows.slice(0, MAX_COPY_ROWS) : sel.rows;
      const index = new Map(source.columns.map((c, i) => [c.name, i]));
      const cols = sel.columns.filter((n) => index.has(n));
      const name = COPY_FORMATS.find((f) => f.format === format)?.label ?? format;
      try {
        const values = await readRows(
          source,
          rows,
          cols.map((n) => index.get(n)!),
        );
        const text = formatRows(
          format,
          cols.map((n) => ({
            name: n,
            label: label(layout, n),
            format: source.columns[index.get(n)!]!,
          })),
          values,
          { table: tableName(tab.title), headers: opts.headers },
        );
        await navigator.clipboard.writeText(text);
        notice(
          `Copied ${plural(rows.length, "row")} as ${name}` +
            (cut ? ` (the first ${formatCount(MAX_COPY_ROWS)} of the selection)` : ""),
        );
      } catch (e) {
        notice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [source, layout, notice, tab.title],
  );

  /** Copies the view (shown columns, names, filters, search, sort) as runnable SQL. */
  const readerSql = tab.info?.readerSql;
  const copyViewSql = useCallback(async () => {
    if (!baseId || !readerSql) return;
    try {
      const sql = await viewSql(
        baseId,
        { ...view, columns: visible(layout) },
        readerSql,
        layout.labels,
      );
      await navigator.clipboard.writeText(sql);
      notice("Copied the view as SQL");
    } catch (e) {
      notice(`Couldn't copy the view: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [baseId, readerSql, view, layout, notice]);

  /** Opens the export dialog for the view (and the grid's selection). */
  const showExport = useExport((s) => s.show);
  const viewRows = tab.viewState?.dataset?.rowCount ?? tab.info?.dataset?.rowCount;
  const openExport = useCallback(() => {
    if (!baseId || viewRows === undefined) return;
    showExport({
      datasetId: baseId,
      spec: { ...view, columns: visible(layout) },
      labels: layout.labels,
      title: tab.title,
      rowCount: viewRows,
      selection: grid.current?.selection() ?? null,
    });
  }, [baseId, viewRows, showExport, view, layout, tab.title]);
  /** A cell's value as shown (null for NULL), from the loaded rows. */
  const cellText = (column: string, row: number): string | null => {
    const i = source?.columns.findIndex((c) => c.name === column) ?? -1;
    const info = source?.columns[i];
    if (!source || !info) return null;
    const v = source.getValue(row, i);
    return v === NOT_LOADED ? null : formatValue(v, info);
  };
  const cellActions = (column: string, row: number): CellMenuActions => {
    const i = source?.columns.findIndex((c) => c.name === column) ?? -1;
    const info = source?.columns[i];
    const raw = source && i >= 0 ? source.getValue(row, i) : NOT_LOADED;
    const write = (text: string, what: string) =>
      void navigator.clipboard.writeText(text).then(
        () => notice(`Copied ${what}`),
        (e: unknown) => notice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`),
      );
    const byValue = (exclude: boolean) =>
      info && raw !== NOT_LOADED && onViewChange ? filterForValue(info, raw, exclude) : null;
    const equals = byValue(false);
    const notEquals = byValue(true);
    return {
      copy: (headers) => void copySelection("tsv", { headers }),
      copyAs: (format) => void copySelection(format),
      copyValue: () => write(cellText(column, row) ?? "", "the cell value"),
      copyColumnName: () => write(column, `the column name "${column}"`),
      filterEquals: equals ? () => setFilters([...filters, equals]) : undefined,
      filterNotEquals: notEquals ? () => setFilters([...filters, notEquals]) : undefined,
      sort: onViewChange ? (descending) => setSort([{ column, descending }]) : undefined,
      profile: baseId ? () => showProfile(column) : undefined,
      reload: onReload,
    };
  };

  const running = tab.viewState?.status === "running";
  const sorting = !!tab.viewState?.sorting;
  const importing = tab.import?.status === "running";
  const canExport = tab.status === "ready" && !!baseId && viewRows !== undefined && !running;
  const commands = useMemo<Command[]>(() => {
    if (tab.status !== "ready" || !source) return [];
    const list: Command[] = [];
    const add = (c: Command) => list.push(c);
    if (onViewChange) {
      // Command closures run when picked in the palette, never during render.
      // eslint-disable-next-line react-hooks/refs
      add({
        id: "search",
        title: "Search in data",
        group: "View",
        shortcut: `${modKey}+F`,
        run: () => searchInput.current?.focus(),
      });
    }
    add({
      id: "go-to-row",
      title: "Go to row…",
      group: "View",
      shortcut: `${modKey}+G`,
      run: () => setGoToOpen(true),
    });
    if (onViewChange && filters.length > 0)
      add({
        id: "clear-filters",
        title: "Clear filters",
        group: "View",
        run: () => setFilters([]),
      });
    if (onViewChange && sort.length > 0)
      add({ id: "clear-sort", title: "Clear sort", group: "View", run: () => setSort([]) });
    if (onViewChange && view.search)
      add({
        id: "clear-search",
        title: "Clear search",
        group: "View",
        run: () => onViewChange({ ...view, search: undefined }),
      });
    if (onLayoutChange && layout.hidden.length > 0)
      add({
        id: "show-all-columns",
        title: "Show all columns",
        group: "Columns",
        run: () => onLayoutChange(showAll(layout)),
      });
    if (running)
      add({
        id: "cancel-view",
        title: "Cancel running query",
        group: "View",
        keywords: "stop",
        run: () => cancelView(tab.id),
      });
    else if (sorting)
      add({
        id: "stop-sorting",
        title: "Stop sorting (keep filters)",
        group: "View",
        keywords: "cancel",
        run: () => cancelView(tab.id),
      });
    if (importing && onCancelImport)
      add({ id: "cancel-import", title: "Cancel import", group: "File", run: onCancelImport });
    for (const f of COPY_FORMATS) {
      // eslint-disable-next-line react-hooks/refs -- runs when picked, not during render
      add({
        id: `copy-${f.format}`,
        title: `Copy selection as ${f.label}`,
        group: "Copy",
        shortcut: f.format === "tsv" ? `${modKey}+C` : undefined,
        run: () => void copySelection(f.format),
      });
    }
    if (canExport)
      // eslint-disable-next-line react-hooks/refs -- reads the grid's selection when picked
      add({
        id: "export",
        title: "Export view…",
        group: "File",
        shortcut: `${modKey}+E`,
        keywords: "save csv parquet excel xlsx json download",
        run: openExport,
      });
    if (baseId && readerSql)
      add({
        id: "copy-view-sql",
        title: "Copy view as SQL",
        group: "Copy",
        keywords: "query duckdb",
        run: () => void copyViewSql(),
      });
    for (const name of visible(layout)) {
      const column = columns.find((c) => c.name === name);
      if (!column) continue;
      const shown = label(layout, name);
      if (onViewChange) {
        add({
          id: `filter:${name}`,
          title: `Filter ${shown}…`,
          group: "Columns",
          run: () => filterColumn(column, gridAnchor()),
        });
        add({
          id: `sort-asc:${name}`,
          title: `Sort by ${shown} ascending`,
          group: "Columns",
          run: () => setSort([{ column: name, descending: false }]),
        });
        add({
          id: `sort-desc:${name}`,
          title: `Sort by ${shown} descending`,
          group: "Columns",
          run: () => setSort([{ column: name, descending: true }]),
        });
      }
      if (baseId)
        add({
          id: `profile:${name}`,
          title: `Column profile: ${shown}`,
          group: "Columns",
          keywords: "statistics stats",
          run: () => showProfile(name),
        });
    }
    return list;
    // setFilters, setSort and filterColumn are recreated each render; the
    // state they read is listed, so the list only changes when it should.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tab.status,
    tab.id,
    source,
    onViewChange,
    onLayoutChange,
    onCancelImport,
    filters,
    sort,
    view,
    layout,
    columns,
    running,
    sorting,
    importing,
    baseId,
    readerSql,
    copySelection,
    copyViewSql,
    cancelView,
    canExport,
    openExport,
  ]);
  useRegisterCommands("file", commands);

  const showSettings =
    isCsv(tab) || (tab.status === "error" && /\.(csv|tsv|txt|tab)/i.test(tab.path));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "g" && source) {
        e.preventDefault();
        setGoToOpen(true);
      }
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "e" && canExport) {
        e.preventDefault();
        openExport();
      }
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "f" && searchInput.current) {
        e.preventDefault();
        searchInput.current.focus();
        searchInput.current.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source, canExport, openExport]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate font-medium text-fg" title={tab.path}>
          {tab.title}
        </span>
        {tab.info && (
          <span className="rounded-[var(--radius-sm)] bg-surface-2 px-1.5 py-px text-[11px] text-fg-muted uppercase">
            {tab.info.format === "sql" ? (
              "SQL result"
            ) : (
              <>
                {tab.info.format}
                {tab.info.compression !== "none" && ` · ${tab.info.compression}`} ·{" "}
                {formatBytes(tab.info.sizeBytes)}
              </>
            )}
          </span>
        )}
        <div className="flex-1" />
        {canExport && (
          <Button size="sm" variant="ghost" onClick={openExport} title={`Export (${modKey}+E)`}>
            <Download className="size-3.5" aria-hidden /> Export
          </Button>
        )}
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
          sort={sort}
          onSortChange={setSort}
          end={
            <SearchBox
              ref={searchInput}
              value={view.search ?? ""}
              onChange={(search) => onViewChange?.({ ...view, search: search || undefined })}
            />
          }
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
      {menu && (
        <ColumnMenu
          column={menu.column.name}
          anchor={menu.anchor}
          sort={sort}
          onOpenChange={(o) => !o && setMenu(null)}
          onSort={setSort}
          onFilter={() => filterColumn(menu.column, menu.anchor)}
          {...(onLayoutChange && {
            pinned: layout.pinned.includes(menu.column.name),
            onPin: (p: boolean) => onLayoutChange(setPinned(layout, menu.column.name, p)),
            onHide:
              visible(layout).length > 1
                ? () => onLayoutChange(setHidden(layout, menu.column.name, true))
                : undefined,
            onRename: () => setRenaming({ column: menu.column.name, anchor: menu.anchor }),
            onAutoFit: () => grid.current?.autoFit(menu.column.name),
          })}
          onProfile={baseId ? () => showProfile(menu.column.name) : undefined}
        />
      )}
      {renaming && onLayoutChange && (
        <RenameColumn
          column={renaming.column}
          current={label(layout, renaming.column)}
          anchor={renaming.anchor}
          onOpenChange={(o) => !o && setRenaming(null)}
          onRename={(name) => onLayoutChange(rename(layout, renaming.column, name))}
        />
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
        <div className="flex min-h-0 flex-1">
          <DataGrid
            ref={grid}
            source={source}
            layout={layout}
            onLayoutChange={onLayoutChange}
            onHeaderMenu={onViewChange ? onHeaderMenu : undefined}
            onHeaderClick={onViewChange ? onHeaderClick : undefined}
            filteredColumns={filtered}
            sort={sort}
            highlight={tab.viewState?.dataset ? view.search : undefined}
            histograms={chartsWanted ? charts : undefined}
            onCellMenu={(column, row, p) =>
              setCellMenu({
                column,
                row,
                anchor: rectAnchor({ x: p.x, y: p.y, width: 1, height: 1 }),
              })
            }
          />
          {cellMenu && (
            <CellMenu
              anchor={cellMenu.anchor}
              column={label(layout, cellMenu.column)}
              valueText={cellText(cellMenu.column, cellMenu.row) ?? "null"}
              onOpenChange={(o) => !o && setCellMenu(null)}
              {...cellActions(cellMenu.column, cellMenu.row)}
            />
          )}
          <GoToRow
            open={goToOpen}
            onOpenChange={setGoToOpen}
            rowCount={source.rowCount}
            onGo={(row) => grid.current?.scrollToRow(row - 1)}
          />
          {profileOpen && !profiled && (
            <ProfilePicker
              columns={visible(layout).map((c) => ({ name: c, label: label(layout, c) }))}
              onPick={showProfile}
              onClose={() => setProfileOpen(false)}
            />
          )}
          {profileOpen && profiled && (
            <ProfilePanel
              title={label(layout, profiled)}
              // The previous result stays on screen while the new one loads.
              profile={profile?.column === profiled ? profile.data : undefined}
              loading={profile?.key !== profileKey}
              error={profile?.key === profileKey ? profile.error : undefined}
              onClose={() => setProfileOpen(false)}
            />
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-fg-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading {tab.title}…
        </div>
      )}
    </div>
  );
}
