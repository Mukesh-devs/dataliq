import { CircleAlert, LoaderCircle, Play, Square, WandSparkles, X } from "lucide-react";
import { useMemo } from "react";
import { formatCount, formatDuration } from "../../lib/format";
import { modKey } from "../../lib/platform";
import { useNotice } from "../../stores/notice";
import { MAX_RESULT_ROWS, MIN_PANEL_HEIGHT, useSql } from "../../stores/sql";
import { DataGrid } from "../grid/DataGrid";
import { StaticRowSource } from "../grid/rowSource";
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
  const source = useMemo(() => (result ? new StaticRowSource(result.table) : null), [result]);

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

  const status = running
    ? "Running…"
    : error
      ? "The query failed"
      : result
        ? `${result.truncated ? `First ${formatCount(MAX_RESULT_ROWS)}` : formatCount(result.table.numRows)} row${
            result.table.numRows === 1 ? "" : "s"
          } in ${formatDuration(result.elapsedMs)}${
            result.count > 1 ? ` · ${result.count} statements` : ""
          }`
        : tables.length > 0
          ? `Tables: ${tables.map((t) => t.name).join(", ")}`
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
        <div className="min-h-0 w-[45%] min-w-64 border-r border-border">
          <SqlEditor
            ref={setEditor}
            value={text}
            onChange={setText}
            tables={tables}
            onRun={runEditor}
            error={error}
          />
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
