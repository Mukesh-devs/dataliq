import { FileUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CommandPalette } from "../components/palette/CommandPalette";
import { ExportDialog } from "../components/export/ExportDialog";
import { SqlPanel } from "../components/sql/SqlPanel";
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
import { modKey } from "../lib/platform";
import { onViewReady } from "../lib/view";
import { useApp } from "../stores/app";
import { useRegisterCommands, type Command } from "../stores/commands";
import { useLayout } from "../stores/layout";
import { useNotice } from "../stores/notice";
import { useSettings, type ThemePreference } from "../stores/settings";
import { useSql } from "../stores/sql";
import { useEngine } from "../stores/engine";
import { useExport } from "../stores/export";
import { baseName } from "../lib/files";
import { useRecent } from "../stores/recent";
import { baseOf, useTabs, type Tab } from "../stores/tabs";
import { ThemeController } from "./ThemeController";
import { useShortcuts } from "./useShortcuts";
import { useSqlTables } from "./useSqlTables";

/** "filtered", "sorted" or "filtered and sorted", for the status bar. */
function viewVerb(tab: Tab): { ed: string; ing: string } {
  const filtered = (tab.view?.filters?.length ?? 0) > 0 || !!tab.view?.search;
  const sorted = (tab.view?.sort?.length ?? 0) > 0;
  if (filtered && sorted) return { ed: "filtered and sorted", ing: "filtering and sorting" };
  if (sorted) return { ed: "sorted", ing: "sorting" };
  return { ed: "filtered", ing: "filtering" };
}

function statusMessage(tab: Tab | undefined, engineVersion: string | null): string {
  const parts: string[] = [];
  if (!tab) parts.push("Ready");
  else if (tab.status === "loading") parts.push(`Opening ${tab.title}…`);
  else if (tab.status === "error") parts.push("Could not open file");
  else if (tab.recipeState?.status === "waiting") {
    parts.push("Cleaning applies when the import finishes");
    if (tab.import?.status === "running") parts.push("importing…");
  } else if (tab.recipeState?.status === "running") parts.push("Cleaning…");
  else if (tab.viewState?.status === "waiting") {
    parts.push("Filters apply when the import finishes");
    if (tab.import?.status === "running") parts.push("importing…");
  } else if (tab.viewState?.dataset && baseOf(tab).dataset) {
    const v = tab.viewState;
    const rows = v.dataset ? formatCount(v.dataset.rowCount) : "";
    const total = v.totalRows ?? baseOf(tab).dataset!.rowCount;
    parts.push(`${rows} of ${formatCount(total)} rows`);
    const verb = viewVerb(tab);
    if (v.status === "running") parts.push(`${verb.ing}…`);
    else if (v.sorting)
      parts.push(`first rows in ${formatDuration(v.elapsedMs ?? 0)}, sorting the rest…`);
    else parts.push(`${verb.ed} in ${formatDuration(v.fullMs ?? v.elapsedMs ?? 0)}`);
  } else if (tab.viewState?.status === "running") {
    const ing = viewVerb(tab).ing;
    parts.push(`${ing[0]!.toUpperCase()}${ing.slice(1)}…`);
  } else if (tab.recipeState?.outcome) {
    const r = tab.recipeState.outcome;
    parts.push(`${formatCount(r.dataset.rowCount)} rows`);
    parts.push(`cleaned in ${formatDuration(r.elapsedMs)}`);
  } else if (tab.info?.dataset) {
    parts.push(`${formatCount(tab.info.dataset.rowCount)} rows`);
    if (tab.compare) parts.push(`compared in ${formatDuration(tab.compare.elapsedMs)}`);
    else if (tab.info.format === "sql") parts.push("SQL result");
    else if (tab.import?.fromCache) parts.push("from cache");
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
  const {
    tabs,
    activeId,
    setActive,
    openPaths,
    reopen,
    reload,
    cancelImport,
    readDirect,
    close,
    cycle,
  } = useTabs();
  const sidebar = useLayout((s) => s.sidebar);
  const profileOpen = useLayout((s) => s.profile);
  const applyProgress = useTabs((s) => s.applyProgress);
  const setView = useTabs((s) => s.setView);
  const setLayout = useTabs((s) => s.setLayout);
  const applyViewReady = useTabs((s) => s.applyViewReady);
  const cancelView = useTabs((s) => s.cancelView);
  const clearCache = useApp((s) => s.clearCache);
  const setTheme = useSettings((s) => s.setTheme);
  const headerCharts = useSettings((s) => s.headerCharts);
  const setHeaderCharts = useSettings((s) => s.setHeaderCharts);
  const sqlOpen = useSql((s) => s.open);
  const setSqlOpen = useSql((s) => s.setOpen);
  const runEditor = useSql((s) => s.runEditor);
  const formatEditor = useSql((s) => s.formatEditor);
  const notice = useNotice((s) => s.show);
  useSqlTables(tabs, activeId);
  // Open, and the text it starts with ("Copy " for Shift+Ctrl+C).
  const [palette, setPalette] = useState<{ query: string } | null>(null);
  const engineVersion = useEngine((s) => s.version);
  const exportJob = useExport((s) => s.job);
  const cancelExport = useExport((s) => s.cancel);
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
      commandPalette: () => setPalette({ query: "" }),
      copyAs: () => setPalette({ query: "Copy " }),
      toggleSql: () => {
        const open = !useSql.getState().open;
        setSqlOpen(open);
        if (open) setTimeout(() => useSql.getState().editor?.focus(), 0);
      },
      toggleSidebar: () => {
        const l = useLayout.getState();
        l.setSidebar(!l.sidebar);
      },
      toggleProfile: () => {
        const l = useLayout.getState();
        l.setProfile(!l.profile);
      },
    }),
    [openFile, close, cycle, setSqlOpen],
  );
  useShortcuts(shortcuts);

  // App-wide commands; the open file adds its own (FileView).
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "open-file",
        title: "Open file…",
        group: "File",
        shortcut: `${modKey}+O`,
        run: shortcuts.openFile,
      },
    ];
    if (activeId) {
      list.push(
        {
          id: "close-tab",
          title: "Close tab",
          group: "Tabs",
          shortcut: `${modKey}+W`,
          run: shortcuts.closeTab,
        },
        {
          id: "next-tab",
          title: "Next tab",
          group: "Tabs",
          shortcut: "Ctrl+Tab",
          run: shortcuts.nextTab,
        },
        {
          id: "previous-tab",
          title: "Previous tab",
          group: "Tabs",
          shortcut: "Ctrl+Shift+Tab",
          run: shortcuts.previousTab,
        },
      );
    }
    for (const file of recent) {
      list.push({
        id: `recent:${file.path}`,
        title: `Open recent: ${file.name}`,
        group: "File",
        keywords: file.path,
        run: () => void openPaths([file.path]),
      });
    }
    list.push(
      {
        id: "toggle-sidebar",
        title: sidebar ? "Hide sidebar" : "Show sidebar",
        group: "Layout",
        shortcut: `${modKey}+B`,
        keywords: "left panel files columns",
        run: shortcuts.toggleSidebar,
      },
      {
        id: "toggle-profile",
        title: profileOpen ? "Hide column profile panel" : "Show column profile panel",
        group: "Layout",
        shortcut: `${modKey}+Alt+B`,
        keywords: "right panel statistics",
        run: shortcuts.toggleProfile,
      },
    );
    if (active?.path)
      list.push({
        id: "reload-file",
        title: "Reload file (keep filters)",
        group: "File",
        keywords: "refresh",
        run: () => void reload(active.id),
      });
    list.push({
      id: "toggle-sql",
      title: sqlOpen ? "Hide SQL panel" : "Show SQL panel",
      group: "SQL",
      shortcut: `${modKey}+J`,
      keywords: "query toggle",
      run: shortcuts.toggleSql,
    });
    if (sqlOpen) {
      list.push(
        {
          id: "run-sql",
          title: "Run SQL (or the selection)",
          group: "SQL",
          shortcut: `${modKey}+Enter`,
          run: runEditor,
        },
        {
          id: "format-sql",
          title: "Format SQL",
          group: "SQL",
          run: () => {
            const problem = formatEditor();
            if (problem) notice(`Couldn't format: ${problem}`);
          },
        },
      );
    }
    // Opens the SQL panel first if needed, then the list.
    const showLibrary = (library: "history" | "saved") => () => {
      setSqlOpen(true);
      setTimeout(() => useSql.getState().setLibrary(library), 0);
    };
    list.push(
      {
        id: "sql-history",
        title: "SQL history…",
        group: "SQL",
        keywords: "past queries recent",
        run: showLibrary("history"),
      },
      {
        id: "saved-queries",
        title: "Saved queries…",
        group: "SQL",
        keywords: "snippets save query",
        run: showLibrary("saved"),
      },
    );
    const themes: [ThemePreference, string][] = [
      ["light", "Light"],
      ["dark", "Dark"],
      ["system", "Follow system"],
    ];
    for (const [theme, name] of themes) {
      list.push({
        id: `theme-${theme}`,
        title: `Theme: ${name}`,
        group: "Appearance",
        run: () => setTheme(theme),
      });
    }
    list.push(
      {
        id: "header-charts",
        title: headerCharts ? "Hide column histograms" : "Show column histograms",
        group: "Appearance",
        keywords: "header charts",
        run: () => setHeaderCharts(!headerCharts),
      },
      {
        id: "clear-cache",
        title: "Clear cache",
        group: "App",
        run: () => void clearCache(),
      },
    );
    return list;
  }, [
    shortcuts,
    activeId,
    active,
    recent,
    openPaths,
    setTheme,
    headerCharts,
    setHeaderCharts,
    clearCache,
    sqlOpen,
    setSqlOpen,
    sidebar,
    profileOpen,
    reload,
    runEditor,
    formatEditor,
    notice,
  ]);
  useRegisterCommands("app", commands);

  useSubscription(useMemo(() => () => onImportProgress(applyProgress), [applyProgress]));
  useSubscription(useMemo(() => () => onViewReady(applyViewReady), [applyViewReady]));
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

  // The webview's own context menu (reload, print, inspect …) makes no
  // sense in an app; text fields keep it for cut/copy/paste.
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);

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
        onCommands={() => setPalette({ query: "" })}
        panels={{ left: sidebar, right: profileOpen, bottom: sqlOpen }}
        onTogglePanel={(panel) =>
          panel === "left"
            ? shortcuts.toggleSidebar()
            : panel === "right"
              ? shortcuts.toggleProfile()
              : shortcuts.toggleSql()
        }
      />
      <CommandPalette
        // A fresh body (and starting text) each time it opens.
        key={palette ? `open:${palette.query}` : "closed"}
        open={palette !== null}
        onOpenChange={(o) => !o && setPalette(null)}
        initialQuery={palette?.query}
      />
      <div className="flex min-h-0 flex-1">
        {sidebar && (
          <Sidebar
            tabs={tabs}
            active={active}
            onLayoutChange={active ? (l) => setLayout(active.id, l) : undefined}
          />
        )}
        <main className="relative flex min-w-0 flex-1 flex-col bg-bg">
          {active ? (
            <FileView
              key={active.id}
              tab={active}
              onReopen={(o) => void reopen(active.id, o)}
              onReload={active.path ? () => void reload(active.id) : undefined}
              onCancelImport={() => void cancelImport(active.id)}
              onReadDirect={() => void readDirect(active.id)}
              onViewChange={(v) => void setView(active.id, v)}
              onLayoutChange={(l) => setLayout(active.id, l)}
            />
          ) : (
            <EmptyState
              onOpen={() => void openFile()}
              recent={recent}
              onOpenRecent={(p) => void openPaths([p])}
              dragging={dragging}
            />
          )}
          <ExportDialog />
          {sqlOpen && <SqlPanel />}
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
      <StatusBar
        message={
          exportJob
            ? `Exporting ${baseName(exportJob.path)}…${
                exportJob.percent != null ? ` ${Math.floor(exportJob.percent)}%` : ""
              }`
            : statusMessage(active, engineVersion)
        }
        action={
          exportJob
            ? { label: "Cancel export", run: cancelExport }
            : active?.viewState?.status === "running"
              ? { label: "Cancel", run: () => cancelView(active.id) }
              : active?.viewState?.sorting
                ? { label: "Stop sorting", run: () => cancelView(active.id) }
                : undefined
        }
      />
    </div>
  );
}
