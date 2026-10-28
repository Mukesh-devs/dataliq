import {
  ChartColumn,
  CircleAlert,
  Download,
  GitCompareArrows,
  ListChecks,
  LoaderCircle,
  SquareTerminal,
  Table,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeColumns, type ColumnInfo } from "../../lib/arrow";
import { fetchRows } from "../../lib/files";
import { formatBytes, formatCount, formatValue } from "../../lib/format";
import { isUrl } from "../../lib/remote";
import { COPY_FORMATS, formatRows, quoteIdent, tableName, type CopyFormat } from "../../lib/copyAs";
import { formatSql } from "../../lib/sqlFormat";
import { useSql } from "../../stores/sql";
import { isMac, modKey } from "../../lib/platform";
import { useRegisterCommands, type Command } from "../../stores/commands";
import { useNotice } from "../../stores/notice";
import { baseOf, useTabs } from "../../stores/tabs";
import type { Tab } from "../../stores/tabs";
import { RecipePanel } from "../recipe/RecipePanel";
import {
  columnGaps,
  describeGaps,
  describeStep,
  loadRecipe,
  pickRecipeOpen,
  pickRecipeSave,
  readableScript,
  recipeFileName,
  saveRecipe,
  saveRecipeScript,
} from "../../lib/recipe";
import { baseName } from "../../lib/files";
import {
  CHANGED,
  STATUS,
  compareFiles,
  compareSql,
  isChangedCell,
  type RowStatus,
} from "../../lib/compare";
import { CompareBar } from "../compare/CompareBar";
import { QualityPanel } from "../quality/QualityPanel";
import { dataQuality, duplicatesSql, type QualityReport } from "../../lib/quality";
import { CompareDialog, type CompareSide } from "../compare/CompareDialog";
import type { CellTint } from "../grid/gridTheme";
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
import { defaultChart, fitChart } from "../../lib/chart";
import { ChartPanel } from "../chart/ChartPanel";
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
import { DatabaseSettings } from "../import/DatabaseSettings";
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

/** The files of a folder or pattern, for the header's tooltip. */
function filesTitle(f: NonNullable<NonNullable<Tab["info"]>["files"]>): string {
  const more = f.count - f.names.length;
  return [
    ...f.names,
    ...(more > 0 ? [`… and ${formatCount(more)} more`] : []),
    ...(f.skipped > 0
      ? [`(${plural(f.skipped, "other file")} left out: another format, or empty)`]
      : []),
    `The ${f.column} column says which file each row came from.`,
  ].join("\n");
}

const isCsv = (tab: Tab) => tab.info?.format === "csv" || tab.info?.format === "tsv";

/** The view's rows, else the full dataset (paged from the backend), else the preview. */
function useRowSource(tab: Tab): RowSource | null {
  const base = baseOf(tab);
  const preview = base.preview;
  const dataset = tab.viewState?.dataset ?? base.dataset;
  const datasetId = dataset?.id;
  const rowCount = dataset?.rowCount;
  const source = useMemo(() => {
    if (!preview) return null;
    if (datasetId !== undefined && rowCount !== undefined) {
      return new PagedRowSource({
        rowCount,
        columns: describeColumns(preview),
        fetchPage: (start, count) => fetchRows(datasetId, start, count),
      });
    }
    return new StaticRowSource(preview);
  }, [preview, datasetId, rowCount]);
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
  // The cleaned rows when the tab has a recipe, else the file.
  const base = baseOf(tab);
  const basePreview = base.preview;
  const columns = useMemo(() => (basePreview ? describeColumns(basePreview) : []), [basePreview]);
  const view = useMemo(() => tab.view ?? {}, [tab.view]);
  const filters = useMemo(() => view.filters ?? [], [view]);
  const filtered = useMemo(() => new Set(filters.map((f) => f.column)), [filters]);
  // A comparison: the status its rows are filtered to, and its cell fills.
  const shownStatus = filters.find((f) => f.column === STATUS && f.op === "equals" && !f.not) as
    { value: RowStatus } | undefined;
  const isCompare = !!tab.compare;
  const cellTint = useMemo(() => {
    if (!isCompare || !source) return undefined;
    const st = source.columns.findIndex((c) => c.name === STATUS);
    const ch = source.columns.findIndex((c) => c.name === CHANGED);
    if (st < 0) return undefined;
    return (row: number, column: string): CellTint | undefined => {
      const status = source.getValue(row, st);
      if (status === "added" || status === "removed") return status;
      if (status !== "changed") return undefined;
      if (column === STATUS) return "changed";
      const changed = ch < 0 ? null : source.getValue(row, ch);
      return isChangedCell(typeof changed === "string" ? changed : null, column)
        ? "changed"
        : undefined;
    };
  }, [isCompare, source]);
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
  const baseId = base.dataset?.id;
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

  // Cleaning steps, applied to the whole file.
  const setRecipe = useTabs((s) => s.setRecipe);
  const undoRecipe = useTabs((s) => s.undoRecipe);
  const redoRecipe = useTabs((s) => s.redoRecipe);
  const setRecipeOpen = useTabs((s) => s.setRecipeOpen);
  const [cleanColumn, setCleanColumn] = useState<string>();
  const canClean = tab.status === "ready" && !!tab.info && tab.info.format !== "sql";
  const recipeOpen = canClean && !!tab.recipeOpen;
  const recipe = tab.recipe;
  const recipeSteps = useMemo(() => recipe ?? [], [recipe]);
  const canUndo = (tab.recipeHistory?.past.length ?? 0) > 0;
  const canRedo = (tab.recipeHistory?.future.length ?? 0) > 0;
  const cleaning = tab.recipeState?.status === "running";
  const openClean = useCallback(
    (column?: string) => {
      setCleanColumn(column);
      setRecipeOpen(tab.id, true);
    },
    [setRecipeOpen, tab.id],
  );
  const [recipeWarning, setRecipeWarning] = useState<string>();

  // Data quality warnings of the rows the tab reads (cleaned or not).
  const setQualityOpen = useTabs((s) => s.setQualityOpen);
  const qualityOpen = tab.status === "ready" && !!tab.qualityOpen;
  const qualityBase = baseOf(tab).dataset?.id;
  const [quality, setQuality] = useState<{
    base: string;
    report?: QualityReport;
    error?: string;
  } | null>(null);
  const [qualityRun, setQualityRun] = useState(0);
  useEffect(() => {
    if (!qualityOpen || !qualityBase) return;
    let alive = true;
    dataQuality(qualityBase, undefined, `quality:${tab.id}`)
      .then((report) => alive && setQuality({ base: qualityBase, report }))
      .catch((e: unknown) => {
        if (!alive || (e as { kind?: string }).kind === "cancelled") return;
        setQuality({ base: qualityBase, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [qualityOpen, qualityBase, qualityRun, tab.id]);

  // Comparing this file with another open one.
  const openCompare = useTabs((s) => s.openCompare);
  const [comparing, setComparing] = useState<{ anchor: Anchor; others: CompareSide[] } | null>(
    null,
  );
  const compareButton = useRef<HTMLButtonElement>(null);
  const canCompare = tab.status === "ready" && !!baseOf(tab).dataset && !tab.compare;
  const sideOf = (t: Tab): CompareSide => ({
    tabId: t.id,
    title: t.title,
    columns: baseOf(t).columns,
  });
  const startCompare = () => {
    const r = compareButton.current?.getBoundingClientRect();
    const others = useTabs
      .getState()
      .tabs.filter((t) => t.id !== tab.id && t.status === "ready" && baseOf(t).dataset)
      .map(sideOf);
    setComparing({ anchor: r ? rectAnchor(r) : gridAnchor(), others });
  };
  const runCompare = async (beforeId: string, afterId: string, keys: string[]) => {
    const all = useTabs.getState().tabs;
    const [before, after] = [all.find((t) => t.id === beforeId), all.find((t) => t.id === afterId)];
    const [b, a] = [before && baseOf(before), after && baseOf(after)];
    if (!before || !after || !b?.dataset || !a?.dataset) throw new Error("The file was closed.");
    const out = await compareFiles(
      b.dataset.id,
      a.dataset.id,
      keys,
      undefined,
      `compare:${tab.id}`,
    );
    const preview = await fetchRows(out.dataset.id, 0, 200);
    const sql =
      b.readerSql && a.readerSql
        ? await compareSql(b.dataset.id, a.dataset.id, keys, b.readerSql, a.readerSql).catch(
            () => undefined,
          )
        : undefined;
    openCompare({
      compare: { ...out, left: before.title, right: after.title, keys },
      preview,
      sql,
    });
  };
  const fileId = tab.info?.dataset?.id;
  const fileReader = tab.info?.readerSql;
  const fileColumns = tab.info?.columns;
  const hasSteps = recipeSteps.length > 0;
  /** The recipe as a script over the file (needs the full data, for its columns). */
  const recipeSql = useCallback(async () => {
    if (!fileId || !fileReader) throw new Error("the file isn't read in full yet");
    return readableScript(fileId, recipeSteps, fileReader, tab.title);
  }, [fileId, fileReader, recipeSteps, tab.title]);
  const recipeActions = useMemo(() => {
    const failed = (what: string) => (e: unknown) =>
      notice(`Couldn't ${what}: ${e instanceof Error ? e.message : String(e)}`);
    return {
      copySql: () =>
        void recipeSql()
          .then((sql) => navigator.clipboard.writeText(sql))
          .then(() => notice("Copied the recipe as SQL"), failed("copy the recipe")),
      exportSql: async () => {
        try {
          const sql = await recipeSql();
          const path = await pickRecipeSave(recipeFileName(tab.title, "sql"), "sql");
          if (!path) return;
          await saveRecipeScript(path, sql);
          notice(`Saved the recipe script to ${baseName(path)}`);
        } catch (e) {
          failed("export the recipe")(e);
        }
      },
      save: async () => {
        try {
          const path = await pickRecipeSave(recipeFileName(tab.title, "json"), "json");
          if (!path) return;
          await saveRecipe(path, {
            source: tab.title,
            columns: fileColumns ?? [],
            steps: recipeSteps,
          });
          notice(`Saved the recipe to ${baseName(path)}`);
        } catch (e) {
          failed("save the recipe")(e);
        }
      },
      load: async () => {
        try {
          const path = await pickRecipeOpen();
          if (!path) return;
          const file = await loadRecipe(path);
          setRecipeOpen(tab.id, true);
          setRecipeWarning(describeGaps(columnGaps(file.columns, fileColumns ?? [])) ?? undefined);
          await setRecipe(tab.id, file.steps);
          const n = file.steps.length;
          notice(`Loaded ${n} step${n === 1 ? "" : "s"} from ${baseName(path)}`);
        } catch (e) {
          failed("load the recipe")(e);
        }
      },
    };
  }, [
    recipeSql,
    notice,
    tab.title,
    tab.id,
    fileColumns,
    recipeSteps,
    setRecipe,
    setRecipeOpen,
    setRecipeWarning,
  ]);

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
  const readerSql = base.readerSql;
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
  const viewRows = tab.viewState?.dataset?.rowCount ?? base.dataset?.rowCount;
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
  /**
   * Puts the view in the SQL panel as a query over the file's table (fast:
   * no re-reading of the file), ready to edit and run.
   */
  // Grid or chart; a chart needs the full data (not just the preview).
  const setMode = useTabs((s) => s.setMode);
  const setChart = useTabs((s) => s.setChart);
  const canChart = tab.status === "ready" && !!baseId;
  const mode = canChart ? (tab.mode ?? "grid") : "grid";
  const chart = useMemo(
    () => (tab.chart ? fitChart(tab.chart, columns) : defaultChart(columns)),
    [tab.chart, columns],
  );
  const labelOf = useCallback((c: string) => label(layout, c), [layout]);
  const sqlTable = useSql((s) => s.tables.find((t) => t.tabId === tab.id && !t.current)?.name);
  const loadSql = useSql((s) => s.load);
  const openViewInSql = useCallback(async () => {
    if (!baseId || !sqlTable) return;
    try {
      const sql = await viewSql(
        baseId,
        { ...view, columns: visible(layout) },
        quoteIdent(sqlTable),
        layout.labels,
      );
      let text = sql;
      try {
        text = formatSql(sql);
      } catch {
        // Unformatted SQL runs just as well.
      }
      loadSql(text);
    } catch (e) {
      notice(`Couldn't open the view: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [baseId, sqlTable, view, layout, loadSql, notice]);

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

  const running = tab.viewState?.status === "running" || cleaning;
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
    if (tab.status === "ready" && baseOf(tab).dataset)
      add({
        id: "quality",
        title: qualityOpen ? "Hide data quality" : "Check data quality",
        group: "View",
        keywords: "warnings problems nulls spaces duplicates outliers dates types",
        run: () => setQualityOpen(tab.id, !qualityOpen),
      });
    if (canCompare)
      // eslint-disable-next-line react-hooks/refs -- measures the button when picked
      add({
        id: "compare",
        title: "Compare with another file…",
        group: "File",
        keywords: "diff differences versions changes",
        run: startCompare,
      });
    if (canClean) {
      add({
        id: "clean",
        title: recipeOpen ? "Hide cleaning steps" : "Clean data…",
        group: "Clean",
        keywords: "recipe steps trim rename replace split fill duplicates type",
        run: () => (recipeOpen ? setRecipeOpen(tab.id, false) : openClean()),
      });
      add({
        id: "load-recipe",
        title: "Load recipe…",
        group: "Clean",
        keywords: "open steps json apply",
        run: () => void recipeActions.load(),
      });
      if (hasSteps) {
        add({
          id: "save-recipe",
          title: "Save recipe…",
          group: "Clean",
          keywords: "steps json",
          run: () => void recipeActions.save(),
        });
        if (fileId) {
          add({
            id: "export-recipe-sql",
            title: "Export recipe as SQL…",
            group: "Clean",
            keywords: "script duckdb save",
            run: () => void recipeActions.exportSql(),
          });
          add({
            id: "copy-recipe-sql",
            title: "Copy recipe as SQL",
            group: "Copy",
            keywords: "script duckdb clean",
            run: recipeActions.copySql,
          });
        }
      }
      if (canUndo)
        add({
          id: "undo-clean",
          title: "Undo cleaning step",
          group: "Clean",
          run: () => void undoRecipe(tab.id),
        });
      if (canRedo)
        add({
          id: "redo-clean",
          title: "Redo cleaning step",
          group: "Clean",
          run: () => void redoRecipe(tab.id),
        });
    }
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
    if (canChart && chart)
      add(
        mode === "chart"
          ? {
              id: "show-grid",
              title: "Show the grid",
              group: "View",
              keywords: "table rows",
              run: () => setMode(tab.id, "grid"),
            }
          : {
              id: "show-chart",
              title: "Show a chart of the view",
              group: "View",
              keywords: "chart plot graph bar line histogram scatter",
              run: () => setMode(tab.id, "chart"),
            },
      );
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
    if (baseId && sqlTable)
      add({
        id: "open-view-sql",
        title: "Open view in SQL panel",
        group: "SQL",
        keywords: "query edit",
        run: () => void openViewInSql(),
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
    sqlTable,
    openViewInSql,
    canChart,
    chart,
    mode,
    setMode,
    canClean,
    recipeOpen,
    canUndo,
    canRedo,
    openClean,
    setRecipeOpen,
    undoRecipe,
    redoRecipe,
    recipeActions,
    hasSteps,
    fileId,
    canCompare,
    qualityOpen,
    setQualityOpen,
  ]);
  useRegisterCommands("file", commands);

  const showSettings =
    isCsv(tab) || (tab.status === "error" && /\.(csv|tsv|txt|tab)/i.test(tab.path));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      // A click on the grid focuses it on the next frame; after it, or it
      // takes the focus back from what the shortcut opens.
      const afterGrid = (fn: () => void) => {
        e.preventDefault();
        requestAnimationFrame(fn);
      };
      if (mod && key === "g" && source) afterGrid(() => setGoToOpen(true));
      if (mod && key === "e" && canExport) afterGrid(openExport);
      const typing = (e.target as HTMLElement | null)?.closest?.(
        "input, textarea, select, [contenteditable]",
      );
      if (mod && key === "z" && recipeOpen && !typing) {
        e.preventDefault();
        void (e.shiftKey ? redoRecipe(tab.id) : undoRecipe(tab.id));
      }
      if (mod && key === "f" && searchInput.current) {
        // At once, so the next key typed goes in; again after the grid's
        // frame if it took the focus back (keeping what was typed).
        searchInput.current.focus();
        searchInput.current.select();
        afterGrid(() => {
          if (document.activeElement !== searchInput.current) searchInput.current?.focus();
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source, canExport, openExport, recipeOpen, undoRecipe, redoRecipe, tab.id]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate font-medium text-fg" title={tab.path}>
          {tab.title}
        </span>
        {tab.info && (
          <span
            className="shrink-0 rounded-[var(--radius-sm)] bg-surface-2 px-1.5 py-px text-[11px] whitespace-nowrap text-fg-muted uppercase"
            title={tab.info.files ? filesTitle(tab.info.files) : undefined}
          >
            {tab.compare ? (
              "Comparison"
            ) : tab.info.format === "sql" ? (
              "SQL result"
            ) : (
              <>
                {tab.info.format}
                {tab.info.files && ` · ${plural(tab.info.files.count, "file")}`}
                {tab.info.compression !== "none" && ` · ${tab.info.compression}`} ·{" "}
                {isUrl(tab.path) ? "remote" : formatBytes(tab.info.sizeBytes)}
              </>
            )}
          </span>
        )}
        <div className="flex-1" />
        {canChart && chart && (
          <div
            role="radiogroup"
            aria-label="Show"
            className="flex items-center rounded-[var(--radius)] border border-border p-0.5"
          >
            {(
              [
                ["grid", "Grid", Table],
                ["chart", "Chart", ChartColumn],
              ] as const
            ).map(([m, name, Icon]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(tab.id, m)}
                className={`flex h-5 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[12px] ${
                  mode === m ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg"
                }`}
              >
                <Icon className="size-3.5" aria-hidden /> {name}
              </button>
            ))}
          </div>
        )}
        {canClean && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={recipeOpen}
            className={recipeOpen ? "bg-surface-2 text-fg" : undefined}
            onClick={() => (recipeOpen ? setRecipeOpen(tab.id, false) : openClean())}
            title="Cleaning steps: rename, change types, trim, replace, split, …"
          >
            <WandSparkles className="size-3.5" aria-hidden /> Clean
            {recipeSteps.length > 0 && (
              <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-fg tabular">
                {recipeSteps.length}
              </span>
            )}
          </Button>
        )}
        {tab.status === "ready" && baseId && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={qualityOpen}
            className={qualityOpen ? "bg-surface-2 text-fg" : undefined}
            onClick={() => setQualityOpen(tab.id, !qualityOpen)}
            title="Data quality: empty columns, stray spaces, mixed types, dates, outliers, duplicates"
          >
            <ListChecks className="size-3.5" aria-hidden /> Quality
            {quality?.base === baseId && quality.report && quality.report.warnings.length > 0 && (
              <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-fg tabular">
                {quality.report.warnings.length}
              </span>
            )}
          </Button>
        )}
        {canCompare && (
          <Button
            ref={compareButton}
            size="sm"
            variant="ghost"
            onClick={startCompare}
            title="Compare with another open file: added, removed and changed rows"
          >
            <GitCompareArrows className="size-3.5" aria-hidden /> Compare
          </Button>
        )}
        {tab.status === "ready" && baseId && sqlTable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void openViewInSql()}
            title={`The view as a query over ${sqlTable}, to edit and run`}
          >
            <SquareTerminal className="size-3.5" aria-hidden /> Open in SQL
          </Button>
        )}
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
        {tab.info?.database && (
          <DatabaseSettings
            info={tab.info.database}
            onChange={(database) => onReopen({ ...tab.options, database })}
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
          // A URL's size isn't known up front: always show the progress.
          quiet={!isUrl(tab.path) && (tab.info?.sizeBytes ?? 0) < smallFileBytes(settings)}
          onCancel={() => onCancelImport?.()}
          onReadDirect={() => onReadDirect?.()}
          onRetry={() => onReopen(tab.options)}
        />
      )}
      {tab.compare && (
        <CompareBar
          compare={tab.compare}
          shown={shownStatus?.value}
          onShow={(status) =>
            setFilters([
              ...filters.filter((f) => f.column !== STATUS),
              ...(status ? [{ column: STATUS, op: "equals" as const, value: status }] : []),
            ])
          }
        />
      )}
      {comparing && (
        <CompareDialog
          anchor={comparing.anchor}
          current={sideOf(tab)}
          others={comparing.others}
          onOpenChange={(o) => !o && setComparing(null)}
          onCompare={runCompare}
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
          onClean={canClean ? () => openClean(menu.column.name) : undefined}
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
      <div className="flex min-h-0 flex-1">
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
        ) : mode === "chart" && chart && baseId ? (
          <ChartPanel
            tabId={tab.id}
            datasetId={baseId}
            view={view}
            columns={columns}
            labelOf={labelOf}
            chart={chart}
            onChange={(c) => setChart(tab.id, c)}
            title={tab.title}
            readerSql={readerSql}
          />
        ) : source ? (
          <div className="flex min-h-0 min-w-0 flex-1">
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
              cellTint={cellTint}
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
        {qualityOpen && (
          <QualityPanel
            // The last report stays up while the new one is checked.
            report={quality?.report}
            loading={!quality || quality.base !== qualityBase}
            error={quality?.base === qualityBase ? quality?.error : undefined}
            onShow={(w) => onViewChange?.({ ...view, filters: w.filters, search: undefined })}
            onShowCopies={sqlTable ? () => loadSql(duplicatesSql(sqlTable)) : undefined}
            onFix={
              canClean
                ? (step) => {
                    void setRecipe(tab.id, [...recipeSteps, step]);
                    notice(`Added a cleaning step: ${describeStep(step)}`);
                  }
                : undefined
            }
            onRefresh={() => {
              setQuality(null);
              setQualityRun((n) => n + 1);
            }}
            onClose={() => setQualityOpen(tab.id, false)}
          />
        )}
        {recipeOpen && (
          <RecipePanel
            steps={recipeSteps}
            // Outcomes belong to the steps they were computed for.
            outcomes={
              tab.recipeState?.steps === recipe ? tab.recipeState?.outcome?.steps : undefined
            }
            running={cleaning}
            error={tab.recipeState?.status === "error" ? tab.recipeState.error : undefined}
            columns={columns}
            column={cleanColumn}
            canUndo={canUndo}
            canRedo={canRedo}
            onChange={(steps) => {
              setRecipeWarning(undefined);
              void setRecipe(tab.id, steps);
            }}
            onCopySql={hasSteps && fileId ? recipeActions.copySql : undefined}
            onExportSql={hasSteps && fileId ? () => void recipeActions.exportSql() : undefined}
            onSave={hasSteps ? () => void recipeActions.save() : undefined}
            onLoad={() => void recipeActions.load()}
            warning={recipeWarning}
            onUndo={() => void undoRecipe(tab.id)}
            onRedo={() => void redoRecipe(tab.id)}
            onClose={() => setRecipeOpen(tab.id, false)}
          />
        )}
      </div>
    </div>
  );
}
