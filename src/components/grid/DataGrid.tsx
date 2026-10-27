import "@glideapps/glide-data-grid/dist/index.css";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  GridColumnIcon,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type DataEditorRef,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ColumnKind } from "../../lib/arrow";
import {
  fitWidth,
  label,
  move,
  pinnedCount,
  reconcile,
  setWidth,
  visible as visibleColumns,
  type ColumnLayout,
} from "../../lib/layout";
import { sortMark, type Bin, type SortKey } from "../../lib/view";
import { toRanges } from "../../lib/exporting";
import { useAppliedTheme } from "../../stores/appliedTheme";
import { initialWidth, toGridCell, type CellStyle } from "./cells";
import {
  chartColor,
  gridTheme,
  matchColor,
  nullColor,
  rowHeight,
  tintColors,
  type CellTint,
} from "./gridTheme";
import { CHART_HEIGHT, paintHistogram } from "./headerChart";
import { paintMatches } from "./highlight";
import type { RowSource } from "./rowSource";
import { scrollToRow } from "./scrollToRow";

const ICONS: Partial<Record<ColumnKind, GridColumnIcon>> = {
  integer: GridColumnIcon.HeaderNumber,
  number: GridColumnIcon.HeaderNumber,
  text: GridColumnIcon.HeaderString,
  boolean: GridColumnIcon.HeaderBoolean,
  date: GridColumnIcon.HeaderDate,
  timestamp: GridColumnIcon.HeaderDate,
  time: GridColumnIcon.HeaderTime,
  json: GridColumnIcon.HeaderCode,
  binary: GridColumnIcon.HeaderCode,
};

export interface DataGridHandle {
  /** Scrolls so `row` (0-based) is visible and selects its first cell. */
  scrollToRow(row: number): void;
  /** Sets a column's width to fit its header and the rows on screen. */
  autoFit(column: string): void;
  /**
   * The selected cells: shown columns in display order and row indices in
   * order, at most `maxRows + 1` of them (so callers can tell there are more).
   * Selected rows take every shown column; selected columns every row.
   * Null when nothing is selected.
   */
  selected(maxRows: number): SelectedCells | null;
  /**
   * The same selection as row ranges (`[start, end)`), for any number of
   * rows; for export.
   */
  selection(): SelectedRanges | null;
}

export interface SelectedRanges {
  columns: string[];
  rows: [number, number][];
}

export interface SelectedCells {
  columns: string[];
  rows: number[];
}

/** Up to `max` indices of a selection, in order. */
function take(sel: Iterable<number>, max: number): number[] {
  const out: number[] = [];
  for (const i of sel) {
    if (out.length >= max) break;
    out.push(i);
  }
  return out;
}

interface DataGridProps {
  source: RowSource;
  /** Called with the first visible row and the number of visible rows. */
  onVisibleRowsChange?: (first: number, count: number) => void;
  /** Column order, hidden/pinned columns, names and widths (all columns by default). */
  layout?: ColumnLayout;
  /** Resizing, auto-fit or dragging a header to a new place changes the layout. */
  onLayoutChange?: (layout: ColumnLayout) => void;
  /** Header menu (or right-click) on a column; `bounds` is in client coordinates. */
  onHeaderMenu?: (column: string, bounds: Rectangle) => void;
  /** Columns with an active filter, marked in the header. */
  filteredColumns?: ReadonlySet<string>;
  /** Current sort, shown as arrows in the headers. */
  sort?: SortKey[];
  /** Header clicked (outside its menu button); `add` = Shift held. */
  onHeaderClick?: (column: string, add: boolean) => void;
  /** Search text to highlight in text cells. */
  highlight?: string;
  /**
   * Right-click on a cell (`row` 0-based), at `point` in client coordinates.
   * The cell is selected first unless it is already part of the selection.
   */
  onCellMenu?: (column: string, row: number, point: { x: number; y: number }) => void;
  /**
   * Small histograms drawn under the header titles, by column name. Given
   * (even empty, while loading) makes the headers taller to fit them.
   */
  histograms?: ReadonlyMap<string, Bin[]>;
  /** A fill for some cells (a comparison's changed cells, added and removed rows). */
  cellTint?: (row: number, column: string) => CellTint | undefined;
}

/** Width of Glide's header menu button (`menuButtonSize` in its source). */
const MENU_BUTTON_WIDTH = 30;

const HEADER_HEIGHT = 32;
/** Header height with room for a histogram under the title. */
const CHART_HEADER_HEIGHT = HEADER_HEIGHT + CHART_HEIGHT + 4;

const emptySelection: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

/**
 * Canvas data grid over a RowSource. It only asks for the visible rows; pages
 * arrive asynchronously and only the affected cells are redrawn.
 */
export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid(
  {
    source,
    layout: layoutIn,
    onLayoutChange,
    onVisibleRowsChange,
    onHeaderMenu,
    filteredColumns,
    sort,
    onHeaderClick,
    highlight,
    histograms,
    onCellMenu,
    cellTint,
  },
  ref,
) {
  const editor = useRef<DataEditorRef>(null);
  const container = useRef<HTMLDivElement>(null);
  const visible = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: 0 });
  const redrawWhenVisible = useRef(false);
  // Changes once the theme / density attributes are applied (CSS tokens).
  const themeVersion = useAppliedTheme((s) => s.version);
  const [fontsReady, setFontsReady] = useState(false);
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => alive && setFontsReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // Recomputed when theme, density or fonts change; tokens come from CSS.
  const { theme, cellStyle, height } = useMemo(() => {
    void themeVersion;
    void fontsReady;
    const style: CellStyle = { nullColor: nullColor(), nullFont: "italic 12px" };
    return { theme: gridTheme(), cellStyle: style, height: rowHeight() };
  }, [themeVersion, fontsReady]);

  // The layout for this source's columns, and the source index of each
  // shown column (display order).
  const layout = useMemo(
    () =>
      reconcile(
        layoutIn,
        source.columns.map((c) => c.name),
      ),
    [layoutIn, source],
  );
  const shown = useMemo(() => {
    const index = new Map(source.columns.map((c, i) => [c.name, i]));
    return visibleColumns(layout)
      .map((name) => index.get(name))
      .filter((i): i is number => i !== undefined);
  }, [layout, source]);
  const nameAt = useCallback(
    (col: number) => source.columns[shown[col] ?? -1]?.name,
    [source, shown],
  );

  const columns: GridColumn[] = useMemo(
    () =>
      shown.map((i) => {
        const c = source.columns[i]!;
        const title = label(layout, c.name);
        return {
          id: c.name,
          title: sort?.length ? `${title} ${sortMark(sort, c.name)}`.trim() : title,
          icon: ICONS[c.kind] ?? GridColumnIcon.HeaderString,
          width: layout.widths[c.name] ?? initialWidth(title, c.kind),
          hasMenu: onHeaderMenu !== undefined,
          ...(filteredColumns?.has(c.name) && {
            themeOverride: { textHeader: theme.accentColor, bgIconHeader: theme.accentColor },
          }),
        };
      }),
    [source, shown, layout, onHeaderMenu, filteredColumns, theme, sort],
  );

  const tints = useMemo(() => {
    void themeVersion;
    return tintColors();
  }, [themeVersion]);
  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const src = shown[col] ?? -1;
      const column = source.columns[src] ?? { kind: "other" as const, name: "" };
      const cell = toGridCell(source.getValue(row, src), column, cellStyle);
      const tint = cellTint?.(row, column.name);
      return tint
        ? { ...cell, themeOverride: { ...cell.themeOverride, bgCell: tints[tint] } }
        : cell;
    },
    [source, shown, cellStyle, cellTint, tints],
  );

  // A new source (e.g. preview -> imported data) must load what is on screen
  // now: the grid does not report its visible region again if it is unchanged.
  useEffect(() => {
    const v = visible.current;
    source.ensure(v.y, v.y + Math.max(v.height, 50) + 1);
    setLoadError(null);
    return source.onError?.((message) => setLoadError(message));
  }, [source]);

  // Redraw only the visible cells of pages that just arrived.
  useEffect(() => {
    return source.subscribe((start, end) => {
      const v = visible.current;
      // Glide hasn't said what is on screen yet (e.g. just mounted after a
      // tab switch, with a fast page): redraw once it does.
      if (v.width === 0 || v.height === 0) {
        redrawWhenVisible.current = true;
        return;
      }
      const from = Math.max(start, v.y);
      const to = Math.min(end, v.y + v.height + 1);
      if (from >= to) return;
      const cells: { cell: Item }[] = [];
      for (let r = from; r < to; r++) {
        for (let c = v.x; c < Math.min(v.x + v.width + 1, shown.length); c++) {
          cells.push({ cell: [c, r] });
        }
      }
      editor.current?.updateCells(cells);
    });
  }, [source, shown]);

  const onVisibleRegionChanged = useCallback(
    (range: Rectangle) => {
      visible.current = range;
      source.ensure(range.y, range.y + range.height + 1);
      if (redrawWhenVisible.current && range.width > 0 && range.height > 0) {
        redrawWhenVisible.current = false;
        const cells: { cell: Item }[] = [];
        for (let r = range.y; r < Math.min(range.y + range.height + 1, source.rowCount); r++) {
          for (let c = range.x; c < Math.min(range.x + range.width + 1, shown.length); c++) {
            cells.push({ cell: [c, r] });
          }
        }
        editor.current?.updateCells(cells);
      }
      onVisibleRowsChange?.(range.y, range.height);
    },
    [source, onVisibleRowsChange, shown.length],
  );

  // Search matches: painted behind the text of left-aligned text cells.
  const matchFill = useMemo(() => {
    void themeVersion;
    return matchColor();
  }, [themeVersion]);
  const drawCell = useMemo<DrawCellCallback | undefined>(() => {
    if (!highlight) return undefined;
    return (args, drawContent) => {
      const { cell, ctx, rect, theme: t } = args;
      // Search covers text columns only, and never the null / "" markers.
      if (
        cell.kind === GridCellKind.Text &&
        cell.copyData !== "" &&
        source.columns[shown[args.col] ?? -1]?.kind === "text"
      ) {
        paintMatches(ctx, cell.displayData, highlight, rect, {
          font: `${t.baseFontStyle} ${t.fontFamily}`,
          padding: t.cellHorizontalPadding,
          color: matchFill,
        });
      }
      drawContent();
    };
  }, [highlight, matchFill, source, shown]);

  // Header histograms: the title moves up and the bars fill the bottom.
  const headerHeight = histograms ? CHART_HEADER_HEIGHT : HEADER_HEIGHT;
  const barColor = useMemo(() => {
    void themeVersion;
    return chartColor();
  }, [themeVersion]);
  const drawHeader = useMemo<DrawHeaderCallback | undefined>(() => {
    if (!histograms) return undefined;
    return ({ ctx, column, rect, menuBounds }, drawContent) => {
      ctx.save();
      ctx.translate(0, -(CHART_HEIGHT + 4) / 2);
      drawContent();
      ctx.restore();
      const bins = histograms.get(column.id ?? column.title);
      if (!bins) return;
      const left = rect.x + 8;
      // Stop short of the menu button.
      const right = (column.hasMenu ? menuBounds.x : rect.x + rect.width) - 4;
      paintHistogram(
        ctx,
        bins,
        {
          x: left,
          y: rect.y + rect.height - CHART_HEIGHT - 4,
          width: right - left,
          height: CHART_HEIGHT,
        },
        barColor,
      );
    };
  }, [histograms, barColor]);

  // Glide doesn't redraw headers for a new drawHeader; damage them (row -1).
  useEffect(() => {
    if (histograms === undefined) return;
    editor.current?.updateCells(shown.map((_, c) => ({ cell: [c, -1] as Item })));
  }, [histograms, shown]);

  const getCellsForSelection = useCallback(
    (rect: Rectangle) => async () => {
      await source.load(rect.y, rect.y + rect.height);
      const rows: GridCell[][] = [];
      for (let r = rect.y; r < rect.y + rect.height; r++) {
        const row: GridCell[] = [];
        for (let c = rect.x; c < rect.x + rect.width; c++) row.push(getCellContent([c, r]));
        rows.push(row);
      }
      return rows;
    },
    [source, getCellContent],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToRow(row: number) {
        const target = Math.max(0, Math.min(source.rowCount - 1, Math.floor(row)));
        const scroller = container.current?.querySelector<HTMLElement>(".dvn-scroller");
        if (scroller) scrollToRow(scroller, target, height, headerHeight, source.rowCount);
        // Select only once the jump has rendered: Glide scrolls to a newly
        // selected cell with a relative scroll that is wrong for huge tables,
        // but does nothing when the cell is already in view.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            setSelection({
              ...emptySelection,
              current: {
                cell: [0, target],
                range: { x: 0, y: target, width: 1, height: 1 },
                rangeStack: [],
              },
            }),
          ),
        );
      },
      selected(maxRows: number): SelectedCells | null {
        const names = (cols: number[]) =>
          cols.map((c) => nameAt(c)).filter((n): n is string => n !== undefined);
        const all = shown.map((_, c) => c);
        if (selection.rows.length > 0) {
          return { columns: names(all), rows: take(selection.rows, maxRows + 1) };
        }
        if (selection.columns.length > 0) {
          const rows = Array.from({ length: Math.min(source.rowCount, maxRows + 1) }, (_, i) => i);
          return { columns: names(selection.columns.toArray()), rows };
        }
        const range = selection.current?.range;
        if (!range) return null;
        const cols = Array.from({ length: range.width }, (_, i) => range.x + i);
        const rows = Array.from(
          { length: Math.min(range.height, maxRows + 1) },
          (_, i) => range.y + i,
        );
        return { columns: names(cols), rows };
      },
      selection(): SelectedRanges | null {
        const names = (cols: number[]) =>
          cols.map((c) => nameAt(c)).filter((n): n is string => n !== undefined);
        const all = shown.map((_, c) => c);
        if (selection.rows.length > 0) {
          return { columns: names(all), rows: toRanges(selection.rows) };
        }
        if (selection.columns.length > 0) {
          return { columns: names(selection.columns.toArray()), rows: [[0, source.rowCount]] };
        }
        const range = selection.current?.range;
        if (!range) return null;
        const cols = Array.from({ length: range.width }, (_, i) => range.x + i);
        return { columns: names(cols), rows: [[range.y, range.y + range.height]] };
      },
      autoFit(column: string) {
        const src = source.columns.findIndex((c) => c.name === column);
        const col = source.columns[src];
        if (!col || !onLayoutChange) return;
        // Measure the header and the rows on screen (those are loaded).
        const ctx = document.createElement("canvas").getContext("2d");
        if (!ctx) return;
        const font = theme.fontFamily ?? "monospace";
        const measureWith = (f: string) => (s: string) => {
          ctx.font = f;
          return ctx.measureText(s).width;
        };
        const v = visible.current;
        const values: string[] = [];
        for (let r = v.y; r < Math.min(source.rowCount, v.y + Math.max(v.height, 50)); r++) {
          const cell = toGridCell(source.getValue(r, src), col, cellStyle);
          if (cell.kind === GridCellKind.Text || cell.kind === GridCellKind.Number)
            values.push(cell.displayData);
        }
        const title = `${label(layout, column)} ${sortMark(sort ?? [], column)}`.trim();
        const width = fitWidth(
          title,
          values,
          {
            header: measureWith(`${theme.headerFontStyle ?? "600 12px"} ${font}`),
            cell: measureWith(`${theme.baseFontStyle ?? "12px"} ${font}`),
          },
          // Type icon + gap, and the menu button.
          { padding: theme.cellHorizontalPadding ?? 8, headerExtra: 26 + MENU_BUTTON_WIDTH },
        );
        onLayoutChange(setWidth(layout, column, width));
      },
    }),
    [
      source,
      height,
      headerHeight,
      layout,
      onLayoutChange,
      theme,
      cellStyle,
      sort,
      selection,
      shown,
      nameAt,
    ],
  );

  const digits = String(source.rowCount).length;

  return (
    <div ref={container} className="relative min-h-0 flex-1" data-testid="data-grid">
      {loadError && (
        <div
          role="alert"
          className="absolute right-3 bottom-3 z-10 max-w-md rounded-[var(--radius)] border border-border bg-bg px-3 py-2 text-[12px] text-fg-muted shadow-[0_4px_12px_rgb(0_0_0/0.08)]"
        >
          Some rows could not be loaded: {loadError}
        </div>
      )}
      <DataEditor
        ref={editor}
        width="100%"
        height="100%"
        columns={columns}
        rows={source.rowCount}
        getCellContent={getCellContent}
        onVisibleRegionChanged={onVisibleRegionChanged}
        getCellsForSelection={getCellsForSelection}
        gridSelection={selection}
        onGridSelectionChange={setSelection}
        onHeaderMenuClick={(col, bounds) => {
          const name = nameAt(col);
          if (name !== undefined) onHeaderMenu?.(name, bounds);
        }}
        onHeaderClicked={(col, e) => {
          if (!onHeaderClick) return;
          // The menu button has its own handler.
          if (onHeaderMenu && e.localEventX > e.bounds.width - MENU_BUTTON_WIDTH) return;
          e.preventDefault(); // sort instead of selecting the column
          // Glide selected the column on mouse down; a sort click shouldn't.
          setSelection(emptySelection);
          const name = nameAt(col);
          if (name !== undefined) onHeaderClick(name, e.shiftKey);
        }}
        onCellContextMenu={([col, row], e) => {
          if (!onCellMenu) return;
          e.preventDefault();
          const name = nameAt(col);
          if (name === undefined) return;
          const range = selection.current?.range;
          const inRange =
            range &&
            col >= range.x &&
            col < range.x + range.width &&
            row >= range.y &&
            row < range.y + range.height;
          if (!inRange && !selection.rows.hasIndex(row) && !selection.columns.hasIndex(col)) {
            setSelection({
              ...emptySelection,
              current: {
                cell: [col, row],
                range: { x: col, y: row, width: 1, height: 1 },
                rangeStack: [],
              },
            });
          }
          onCellMenu(name, row, { x: e.bounds.x + e.localEventX, y: e.bounds.y + e.localEventY });
        }}
        onHeaderContextMenu={(col, e) => {
          if (!onHeaderMenu) return;
          e.preventDefault();
          const name = nameAt(col);
          // Client coordinates, like the menu click.
          if (name !== undefined) onHeaderMenu(name, e.bounds);
        }}
        onColumnResize={(column, newSize) =>
          onLayoutChange?.(setWidth(layout, column.id ?? column.title, newSize))
        }
        onColumnMoved={
          onLayoutChange ? (from, to) => onLayoutChange(move(layout, from, to)) : undefined
        }
        drawCell={drawCell}
        drawHeader={drawHeader}
        rowMarkers="number"
        rowMarkerWidth={Math.max(40, digits * 8 + 20)}
        rowHeight={height}
        headerHeight={headerHeight}
        smoothScrollX
        smoothScrollY
        theme={theme}
        freezeColumns={pinnedCount(layout)}
        keybindings={{ search: false, selectAll: true, copy: true }}
      />
    </div>
  );
});
