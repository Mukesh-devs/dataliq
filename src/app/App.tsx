import { FileUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../components/shell/EmptyState";
import { FileView } from "../components/shell/FileView";
import { Sidebar } from "../components/shell/Sidebar";
import { StatusBar } from "../components/shell/StatusBar";
import { TabBar } from "../components/shell/TabBar";
import {
  onFileDrop,
  onImportProgress,
  onMenu,
  onOpenFiles,
  pickFiles,
  takeStartupFiles,
} from "../lib/files";
import { formatCount, formatDuration } from "../lib/format";
import { useApp } from "../stores/app";
import { useEngine } from "../stores/engine";
import { useRecent } from "../stores/recent";
import { useTabs, type Tab } from "../stores/tabs";
import { ThemeController } from "./ThemeController";
import { useShortcuts } from "./useShortcuts";

function statusMessage(tab: Tab | undefined, engineVersion: string | null): string {
  const parts: string[] = [];
  if (!tab) parts.push("Ready");
  else if (tab.status === "loading") parts.push(`Opening ${tab.title}…`);
  else if (tab.status === "error") parts.push("Could not open file");
  else if (tab.info?.dataset) {
    parts.push(`${formatCount(tab.info.dataset.rowCount)} rows`);
    if (tab.import?.fromCache) parts.push("from cache");
    else if (tab.info.dataset.cached === false)
      parts.push(tab.info.format === "parquet" ? "queried in place" : "read directly");
    else parts.push(`imported in ${formatDuration(tab.import?.elapsedMs ?? 0)}`);
  } else if (tab.preview) {
    parts.push(`${formatCount(tab.preview.numRows)} preview rows`);
    if (tab.previewMs !== undefined) parts.push(formatDuration(tab.previewMs));
    if (tab.import?.status === "running") parts.push("importing…");
  }
  if (engineVersion) parts.push(`DuckDB ${engineVersion}`);
  return parts.join(" · ");
}

/** Runs `subscribe` once on mount and unsubscribes on unmount. */
function useSubscription(subscribe: () => Promise<() => void>) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void subscribe()
      .then((fn) => (alive ? (unlisten = fn) : fn()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [subscribe]);
}

export function App() {
  const { tabs, activeId, setActive, openPaths, reopen, cancelImport, readDirect, close, cycle } =
    useTabs();
  const applyProgress = useTabs((s) => s.applyProgress);
  const engineVersion = useEngine((s) => s.version);
  const probeEngine = useEngine((s) => s.probe);
  const loadApp = useApp((s) => s.load);
  const refreshCache = useApp((s) => s.refreshCache);
  const recent = useRecent((s) => s.files);
  const [dragging, setDragging] = useState(false);
  const active = tabs.find((t) => t.id === activeId);

  useEffect(() => {
    void probeEngine();
    void loadApp();
    // `bigview file.csv` at startup.
    void takeStartupFiles()
      .then((paths) => {
        if (paths.length > 0) void openPaths(paths);
      })
      .catch(() => {});
  }, [probeEngine, loadApp, openPaths]);

  const openFile = useMemo(
    () => async () => {
      const paths = await pickFiles().catch(() => [] as string[]);
      if (paths.length > 0) await openPaths(paths);
    },
    [openPaths],
  );

  const shortcuts = useMemo(
    () => ({
      openFile: () => void openFile(),
      closeTab: () => {
        const id = useTabs.getState().activeId;
        if (id) close(id);
      },
      nextTab: () => cycle(1),
      previousTab: () => cycle(-1),
    }),
    [openFile, close, cycle],
  );
  useShortcuts(shortcuts);

  useSubscription(useMemo(() => () => onImportProgress(applyProgress), [applyProgress]));
  // A second `bigview <files>` launch forwards its files here.
  useSubscription(useMemo(() => () => onOpenFiles((p) => void openPaths(p)), [openPaths]));
  useSubscription(
    useMemo(
      () => () =>
        onMenu((id) => {
          if (id === "open-file") shortcuts.openFile();
          if (id === "close-tab") shortcuts.closeTab();
        }),
      [shortcuts],
    ),
  );
  useSubscription(
    useMemo(
      () => () =>
        onFileDrop(
          (state) => setDragging(state === "over"),
          (paths) => void openPaths(paths),
        ),
      [openPaths],
    ),
  );

  // Keep the cache size in the sidebar current as imports finish.
  const importsDone = tabs.filter((t) => t.import?.status === "done").length;
  useEffect(() => {
    if (importsDone > 0) void refreshCache();
  }, [importsDone, refreshCache]);

  return (
    <div className="flex h-full flex-col">
      <ThemeController />
      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActive}
        onClose={close}
        onOpen={() => void openFile()}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar tabs={tabs} />
        <main className="relative flex min-w-0 flex-1 flex-col bg-bg">
          {active ? (
            <FileView
              key={active.id}
              tab={active}
              onReopen={(o) => void reopen(active.id, o)}
              onCancelImport={() => void cancelImport(active.id)}
              onReadDirect={() => void readDirect(active.id)}
            />
          ) : (
            <EmptyState
              onOpen={() => void openFile()}
              recent={recent}
              onOpenRecent={(p) => void openPaths([p])}
              dragging={dragging}
            />
          )}
          {active && dragging && (
            <div
              data-testid="drop-overlay"
              className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-[var(--radius-lg)] border-2 border-dashed border-accent bg-accent-soft text-[15px] font-medium text-accent"
            >
              <FileUp className="mr-2 size-5" aria-hidden /> Drop to open in a new tab
            </div>
          )}
        </main>
      </div>
      <StatusBar message={statusMessage(active, engineVersion)} />
    </div>
  );
}
