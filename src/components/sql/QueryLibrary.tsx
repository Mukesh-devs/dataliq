import * as Popover from "@radix-ui/react-popover";
import { Bookmark, CircleAlert, History, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { formatCount } from "../../lib/format";
import {
  clearSqlHistory,
  deleteSavedQuery,
  firstLine,
  formatAgo,
  saveQuery,
  savedQueries,
  sqlHistory,
  type HistoryEntry,
  type SavedQuery,
} from "../../lib/sqlLibrary";
import { useNotice } from "../../stores/notice";
import { useSql } from "../../stores/sql";
import { Button } from "../ui/Button";

const panel =
  "z-50 flex max-h-[min(480px,70vh)] w-[min(520px,calc(100vw-32px))] flex-col rounded-[var(--radius-lg)] border border-border bg-bg text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]";

/** Puts `sql` in the editor (undoable) and closes the list. */
function load(sql: string) {
  const { editor, setLibrary } = useSql.getState();
  editor?.replace(sql);
  setLibrary(null);
  setTimeout(() => editor?.focus(), 0);
}

/** "History" in the SQL toolbar: past runs, newest first, searchable. */
export function HistoryButton() {
  const open = useSql((s) => s.library === "history");
  const setLibrary = useSql((s) => s.setLibrary);
  return (
    <Popover.Root open={open} onOpenChange={(o) => setLibrary(o ? "history" : null)}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" title="Queries you ran">
          <History className="size-3" aria-hidden /> History
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={4}
          collisionPadding={8}
          aria-label="Query history"
          className={panel}
        >
          <HistoryList />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function HistoryList() {
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    // A short pause so typing doesn't read the file for every key.
    const t = setTimeout(() => {
      void sqlHistory(search)
        .then((list) => alive && setEntries(list))
        .catch(() => alive && setEntries([]));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search, version]);
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border p-2">
        <input
          autoFocus
          aria-label="Search history"
          placeholder="Search past queries…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 flex-1 rounded-[var(--radius)] border border-border bg-bg px-2 text-fg outline-none focus:border-accent"
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!entries?.length}
          onClick={() => void clearSqlHistory().then(() => setVersion((v) => v + 1))}
        >
          Clear
        </Button>
      </div>
      <ul aria-label="Past queries" className="min-h-0 flex-1 overflow-y-auto p-1">
        {entries?.length === 0 && (
          <li className="px-2 py-3 text-fg-subtle">
            {search ? "No past query contains that." : "Queries you run appear here."}
          </li>
        )}
        {entries?.map((e) => (
          <li key={`${e.ranAt}:${e.sql}`}>
            <button
              type="button"
              title={e.sql}
              onClick={() => load(e.sql)}
              className="flex w-full flex-col gap-0.5 rounded-[var(--radius)] px-2 py-1.5 text-left hover:bg-hover"
            >
              <span className="w-full truncate font-mono text-[12px] text-fg">
                {firstLine(e.sql)}
              </span>
              <span className="flex items-center gap-1 text-[11px] text-fg-subtle">
                {formatAgo(e.ranAt)}
                {e.error ? (
                  <span className="flex items-center gap-1 text-danger">
                    · <CircleAlert className="size-3" aria-hidden /> failed
                  </span>
                ) : (
                  e.rows != null && ` · ${formatCount(e.rows)} row${e.rows === 1 ? "" : "s"}`
                )}
                {` · ${e.elapsedMs} ms`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** "Saved" in the SQL toolbar: named queries; save the editor's query. */
export function SavedButton() {
  const open = useSql((s) => s.library === "saved");
  const setLibrary = useSql((s) => s.setLibrary);
  return (
    <Popover.Root open={open} onOpenChange={(o) => setLibrary(o ? "saved" : null)}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" title="Saved queries">
          <Bookmark className="size-3" aria-hidden /> Saved
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={4}
          collisionPadding={8}
          aria-label="Saved queries"
          className={panel}
        >
          <SavedList />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SavedList() {
  const [items, setItems] = useState<SavedQuery[] | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState(0);
  const notice = useNotice((s) => s.show);
  useEffect(() => {
    let alive = true;
    void savedQueries()
      .then((list) => alive && setItems(list))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [version]);
  // The selection if there is one, else the whole editor.
  const current = () => useSql.getState().editor?.runnable().script.trim() ?? "";
  const replacing = items?.some((q) => q.name.toLowerCase() === name.trim().toLowerCase());
  return (
    <>
      <form
        className="flex items-center gap-2 border-b border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          const sql = current();
          if (!name.trim() || !sql) return;
          void saveQuery(name, sql).then(
            (q) => {
              notice(`Saved "${q.name}"`);
              setName("");
              setVersion((v) => v + 1);
            },
            (err: unknown) => notice(err instanceof Error ? err.message : String(err)),
          );
        }}
      >
        <input
          autoFocus
          aria-label="Query name"
          placeholder="Name the current query…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-7 flex-1 rounded-[var(--radius)] border border-border bg-bg px-2 text-fg outline-none focus:border-accent"
        />
        <Button size="sm" variant="primary" type="submit" disabled={!name.trim()}>
          {replacing ? "Replace" : "Save"}
        </Button>
      </form>
      <ul aria-label="Saved query list" className="min-h-0 flex-1 overflow-y-auto p-1">
        {items?.length === 0 && (
          <li className="px-2 py-3 text-fg-subtle">
            Name a query above to keep it. Saved queries stay after a restart.
          </li>
        )}
        {items?.map((q) => (
          <li key={q.name} className="group flex items-center gap-1">
            <button
              type="button"
              title={q.sql}
              onClick={() => load(q.sql)}
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-[var(--radius)] px-2 py-1.5 text-left hover:bg-hover"
            >
              <span className="truncate text-fg">{q.name}</span>
              <span className="truncate font-mono text-[11px] text-fg-subtle">
                {firstLine(q.sql)}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Delete ${q.name}`}
              onClick={() => void deleteSavedQuery(q.name).then(() => setVersion((v) => v + 1))}
              className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle opacity-80 hover:bg-hover hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
