import {
  CircleAlert,
  LoaderCircle,
  Pencil,
  Play,
  Square,
  SquareArrowOutUpRight,
  WandSparkles,
  X,
} from "lucide-react";
import { describeColumns } from "../../lib/arrow";
import { fetchRows } from "../../lib/files";
import { useEffect, useMemo, useState } from "react";
import { formatCount, formatDuration } from "../../lib/format";
import { modKey } from "../../lib/platform";
import { useNotice } from "../../stores/notice";
import { cleanTableName } from "../../lib/sql";
import { MAX_RESULT_ROWS, MIN_PANEL_HEIGHT, useSql, type SqlTable } from "../../stores/sql";
import { useTabs } from "../../stores/tabs";
import { RenameTable } from "./RenameTable";
import { DataGrid } from "../grid/DataGrid";
import { PagedRowSource, StaticRowSource, type RowSource } from "../grid/rowSource";
import { Button, IconButton } from "../ui/Button";
import { SqlEditor } from "./SqlEditor";

/** Bottom panel: SQL editor over the open files' tables, and the result. */
export function SqlPanel() {
  const {
    text,
    setText,
    tables,
    running,
    result,
    error,
    cancel,
    height,
    setHeight,
    setOpen,
    setEditor,
    runEditor,
    formatEditor,
  } = useSql();
  const notice = useNotice((s) => s.show);
  // A query's rows page from its dataset; other statements' rows are all here.
  const dataset = result?.dataset;
  const table = result?.table;
  const source = useMemo<RowSource | null>(() => {
    if (!table) return null;
    if (!dataset) return new StaticRowSource(table);
    const first = table;
    return new PagedRowSource({
      rowCount: dataset.rowCount,
      columns: describeColumns(first),
      fetchPage: (start, count) =>
        start === 0 && count <= first.numRows
          ? Promise.resolve(first.slice(0, count))
          : fetchRows(dataset.id, start, count),
    });
  }, [table, dataset]);
  useEffect(() => () => source?.dispose(), [source]);
  const openResult = useTabs((s) => s.openResult);
  const markOwned = useSql((s) => s.markOwned);
  const openInTab = () => {
    if (!result?.dataset || result.owned) return;
    openResult({ dataset: result.dataset, preview: result.table, sql: result.statement });
    markOwned();
  };

  const formatNow = () => {
    const problem = formatEditor();
    if (problem) notice(`Couldn't format: ${problem}`);
  };

  // Drag the top edge to resize.
  const startResize = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startHeight = height;
    const max = window.innerHeight - 160;
    const move = (ev: PointerEvent) =>
      setHeight(Math.min(max, Math.max(MIN_PANEL_HEIGHT, startHeight + startY - ev.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const rowCount = result?.dataset?.rowCount ?? result?.table.numRows ?? 0;
  const status = running
    ? "Running…"
    : error
      ? "The query failed"
      : result
        ? `${result.truncated ? `First ${formatCount(MAX_RESULT_ROWS)}` : formatCount(rowCount)} row${
            rowCount === 1 ? "" : "s"
          } in ${formatDuration(result.elapsedMs)}${
            result.count > 1 ? ` · ${result.count} statements` : ""
          }`
        : tables.length > 0
          ? "Ready"
          : "Open a file to query it as a table";

  return (
    <section
      aria-label="SQL panel"
      className="relative flex shrink-0 flex-col border-t border-border bg-bg"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize SQL panel"
        onPointerDown={startResize}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
      />
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="font-medium text-fg">SQL</span>
        <Button
          size="sm"
          variant="primary"
          onClick={runEditor}
          disabled={!!running}
          title={`Run (${modKey}+Enter)`}
        >
          <Play className="size-3" aria-hidden /> Run
        </Button>
        {running && (
          <Button size="sm" variant="ghost" onClick={cancel}>
            <Square className="size-3" aria-hidden /> Cancel
          </Button>
        )}
        {result?.dataset && !running && (
          <Button
            size="sm"
            variant="ghost"
            onClick={openInTab}
            disabled={result.owned}
            title="Open the result in a tab to filter, sort, profile and copy it"
          >
            <SquareArrowOutUpRight className="size-3" aria-hidden />{" "}
            {result.owned ? "Opened in a tab" : "Open in tab"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={formatNow} title="Format SQL">
          <WandSparkles className="size-3" aria-hidden /> Format
        </Button>
        <span className="tabular flex-1 truncate text-[12px] text-fg-muted" role="status">
          {running && <LoaderCircle className="mr-1 inline size-3 animate-spin" aria-hidden />}
          {status}
        </span>
        <IconButton label={`Close SQL panel (${modKey}+J)`} onClick={() => setOpen(false)}>
          <X className="size-3.5" aria-hidden />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 w-[45%] min-w-64 flex-col border-r border-border">
          {tables.length > 0 && (
            <TableStrip
              tables={tables}
              onInsert={(name) => useSql.getState().editor?.insert(name)}
            />
          )}
          <div className="min-h-0 flex-1">
            <SqlEditor
              ref={setEditor}
              value={text}
              onChange={setText}
              tables={tables}
              onRun={runEditor}
              error={error}
            />
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error ? (
            <div role="alert" className="flex items-start gap-2 p-3 text-[12px]">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
              <pre className="whitespace-pre-wrap font-mono text-fg-muted">{error.message}</pre>
            </div>
          ) : source ? (
            <DataGrid source={source} />
          ) : (
            <p className="p-3 text-[12px] text-fg-subtle">
              Results appear here. Every open file is a table:{" "}
              <code className="font-mono">
                SELECT * FROM {tables[0]?.name ?? "my_file"} LIMIT 10
              </code>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The tables to query: a click types the name into the editor; the pencil
 * renames a file's table. `current_view` is the active tab's view.
 */
function TableStrip({
  tables,
  onInsert,
}: {
  tables: SqlTable[];
  onInsert: (name: string) => void;
}) {
  const tabs = useTabs((s) => s.tabs);
  const setSqlName = useTabs((s) => s.setSqlName);
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <div
      role="list"
      aria-label="Tables"
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1"
    >
      {tables.map((t) => {
        const tab = tabs.find((x) => x.id === t.tabId);
        const chip = (
          <span
            role="listitem"
            className="group inline-flex h-6 items-center rounded-[var(--radius-sm)] border border-border bg-surface text-[12px]"
          >
            <button
              type="button"
              title={
                t.current
                  ? "The active tab's rows: its filters, search and sort"
                  : `${tab?.title ?? t.name} — click to insert`
              }
              onClick={() => onInsert(t.name)}
              className={`px-1.5 font-mono ${t.current ? "text-accent" : "text-fg"} hover:underline`}
            >
              {t.name}
            </button>
            {!t.current && tab && (
              <button
                type="button"
                aria-label={`Rename table ${t.name}`}
                onClick={() => setRenaming(t.name)}
                className="mr-0.5 flex size-5 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle opacity-60 hover:bg-hover hover:text-fg group-hover:opacity-100"
              >
                <Pencil className="size-3" aria-hidden />
              </button>
            )}
          </span>
        );
        if (renaming !== t.name || !tab) return <span key={t.name}>{chip}</span>;
        return (
          <RenameTable
            key={t.name}
            current={t.name}
            fromFile={cleanTableName(tab.title)}
            taken={tables.filter((o) => o.name !== t.name && !o.current).map((o) => o.name)}
            onRename={(name) => setSqlName(tab.id, name)}
            onOpenChange={(open) => !open && setRenaming(null)}
          >
            {chip}
          </RenameTable>
        );
      })}
    </div>
  );
}
