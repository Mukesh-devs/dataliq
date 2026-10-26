import "@glideapps/glide-data-grid/dist/index.css";
import {
  CompactSelection,
  DataEditor,
  GridColumnIcon,
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
import { useResolvedTheme } from "../../app/useResolvedTheme";
import type { ColumnKind } from "../../lib/arrow";
import { useSettings } from "../../stores/settings";
import { initialWidth, toGridCell, type CellStyle } from "./cells";
import { gridTheme, nullColor, rowHeight } from "./gridTheme";
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
}

interface DataGridProps {
  source: RowSource;
  /** Called with the first visible row and the number of visible rows. */
  onVisibleRowsChange?: (first: number, count: number) => void;
}

const HEADER_HEIGHT = 32;

const emptySelection: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

/**
 * Canvas data grid over a RowSource. It only asks for the visible rows; pages
 * arrive asynchronously and only the affected cells are redrawn.
 */
export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid(
  { source, onVisibleRowsChange },
  ref,
) {
  const editor = useRef<DataEditorRef>(null);
  const container = useRef<HTMLDivElement>(null);
  const visible = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: 0 });
  const resolvedTheme = useResolvedTheme();
  const density = useSettings((s) => s.density);
  const [fontsReady, setFontsReady] = useState(false);
  const [widths, setWidths] = useState<Record<string, number>>({});
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
    void resolvedTheme;
    void density;
    void fontsReady;
    const style: CellStyle = { nullColor: nullColor(), nullFont: "italic 12px" };
    return { theme: gridTheme(), cellStyle: style, height: rowHeight() };
  }, [resolvedTheme, density, fontsReady]);

  const columns: GridColumn[] = useMemo(
    () =>
      source.columns.map((c) => ({
        id: c.name,
        title: c.name,
        icon: ICONS[c.kind] ?? GridColumnIcon.HeaderString,
        width: widths[c.name] ?? initialWidth(c.name, c.kind),
      })),
    [source, widths],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const column = source.columns[col] ?? { kind: "other" as const };
      return toGridCell(source.getValue(row, col), column, cellStyle);
    },
    [source, cellStyle],
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
      const from = Math.max(start, v.y);
      const to = Math.min(end, v.y + v.height + 1);
      if (from >= to) return;
      const cells: { cell: Item }[] = [];
      for (let r = from; r < to; r++) {
        for (let c = v.x; c < Math.min(v.x + v.width + 1, source.columns.length); c++) {
          cells.push({ cell: [c, r] });
        }
      }
      editor.current?.updateCells(cells);
    });
  }, [source]);

  const onVisibleRegionChanged = useCallback(
    (range: Rectangle) => {
      visible.current = range;
      source.ensure(range.y, range.y + range.height + 1);
      onVisibleRowsChange?.(range.y, range.height);
    },
    [source, onVisibleRowsChange],
  );

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
        if (scroller) scrollToRow(scroller, target, height, HEADER_HEIGHT, source.rowCount);
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
    }),
    [source, height],
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
        onColumnResize={(column, newSize) =>
          setWidths((w) => ({ ...w, [column.id ?? column.title]: newSize }))
        }
        rowMarkers="number"
        rowMarkerWidth={Math.max(40, digits * 8 + 20)}
        rowHeight={height}
        headerHeight={HEADER_HEIGHT}
        smoothScrollX
        smoothScrollY
        theme={theme}
        freezeColumns={0}
        keybindings={{ search: false, selectAll: true, copy: true }}
      />
    </div>
  );
});
