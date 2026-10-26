import { useEffect } from "react";
import { EmptyState } from "../components/shell/EmptyState";
import { FileView } from "../components/shell/FileView";
import { Sidebar } from "../components/shell/Sidebar";
import { StatusBar } from "../components/shell/StatusBar";
import { TabBar } from "../components/shell/TabBar";
import { onImportProgress, pickFile } from "../lib/files";
import { formatCount, formatDuration } from "../lib/format";
import { useApp } from "../stores/app";
import { useEngine } from "../stores/engine";
import { useTabs, type Tab } from "../stores/tabs";
import { ThemeController } from "./ThemeController";

function statusMessage(tab: Tab | undefined, engineVersion: string | null): string {
  const parts: string[] = [];
  if (!tab) parts.push("Ready");
  else if (tab.status === "loading") parts.push(`Opening ${tab.title}…`);
  else if (tab.status === "error") parts.push("Could not open file");
  else if (tab.info?.dataset) {
    parts.push(`${formatCount(tab.info.dataset.rowCount)} rows`);
    if (tab.import?.fromCache) parts.push("from cache");
    else if (tab.info.dataset.cached === false) parts.push("read directly");
    else parts.push(`imported in ${formatDuration(tab.import?.elapsedMs ?? 0)}`);
  } else if (tab.preview) {
    parts.push(`${formatCount(tab.preview.numRows)} preview rows`);
    if (tab.previewMs !== undefined) parts.push(formatDuration(tab.previewMs));
    if (tab.import?.status === "running") parts.push("importing…");
  }
  if (engineVersion) parts.push(`DuckDB ${engineVersion}`);
  return parts.join(" · ");
}

export function App() {
  const { tabs, activeId, setActive, openPath, reopen, cancelImport, readDirect } = useTabs();
  const loadApp = useApp((s) => s.load);
  const refreshCache = useApp((s) => s.refreshCache);
  const engineVersion = useEngine((s) => s.version);
  const probeEngine = useEngine((s) => s.probe);
  const active = tabs.find((t) => t.id === activeId);

  useEffect(() => {
    void probeEngine();
    void loadApp();
  }, [probeEngine, loadApp]);

  const applyProgress = useTabs((s) => s.applyProgress);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onImportProgress(applyProgress)
      .then((fn) => (alive ? (unlisten = fn) : fn()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [applyProgress]);

  // Keep the cache size in the sidebar current as imports finish.
  const importsDone = tabs.filter((t) => t.import?.status === "done").length;
  useEffect(() => {
    if (importsDone > 0) void refreshCache();
  }, [importsDone, refreshCache]);

  const openFile = async () => {
    const path = await pickFile().catch(() => null);
    if (path) await openPath(path);
  };

  return (
    <div className="flex h-full flex-col">
      <ThemeController />
      <TabBar tabs={tabs} activeId={activeId} onSelect={setActive} onOpen={openFile} />
      <div className="flex min-h-0 flex-1">
        <Sidebar tabs={tabs} />
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          {active ? (
            <FileView
              key={active.id}
              tab={active}
              onReopen={(o) => void reopen(active.id, o)}
              onCancelImport={() => void cancelImport(active.id)}
              onReadDirect={() => void readDirect(active.id)}
            />
          ) : (
            <EmptyState onOpen={openFile} recent={[]} onOpenRecent={(p) => void openPath(p)} />
          )}
        </main>
      </div>
      <StatusBar message={statusMessage(active, engineVersion)} />
    </div>
  );
}
