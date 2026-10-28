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
import { OpenPattern } from "../components/shell/OpenPattern";
import { OpenUrl } from "../components/shell/OpenUrl";
import { HelpDialog, type HelpTopic } from "../components/shell/HelpDialog";
import { MenuBar } from "../components/shell/MenuBar";
import { UpdateDialog } from "../components/shell/UpdateDialog";
import { SettingsDialog } from "../components/settings/SettingsDialog";
import { call } from "../lib/ipc";
import { MENUS, resolveMenus, toNative } from "../lib/menus";
import {
  onFileDrop,
  onImportProgress,
  onMenu,
  onOpenFiles,
  pickFiles,
  pickFolder,
  sampleDataset,
  takeStartupFiles,
} from "../lib/files";
import { formatCount, formatDuration } from "../lib/format";
import { isMac, modKey } from "../lib/platform";
import { onViewReady } from "../lib/view";
import { useApp } from "../stores/app";
import { allCommands, useCommands, useRegisterCommands, type Command } from "../stores/commands";
import { useLayout } from "../stores/layout";
import { useNotice } from "../stores/notice";
import { useUpdate } from "../stores/update";
import { useWorkspace } from "../stores/workspace";
import { isWorkspacePath } from "../lib/workspace";
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
      parts.push(
        tab.info.format === "parquet" || tab.info.format === "duckdb"
          ? "queried in place"
          : "read directly",
      );
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

/** Runs a registered command by id: what a menu item does. */
function runCommand(id: string) {
  allCommands(useCommands.getState().sources)
    .find((c) => c.id === id)
    ?.run();
}

/**
 * The menus, following the commands there are right now and the recent
 * files: drawn in the window on Windows and Linux, sent to the native menu
 * bar on macOS. Its own component, so only it re-renders when the commands
 * change (commands are registered while rendering the rest of the app).
 */
function AppMenus() {
  const sources = useCommands((s) => s.sources);
  const recent = useRecent((s) => s.files);
  const menus = useMemo(
    () => resolveMenus(MENUS, allCommands(sources), recent, isMac),
    [sources, recent],
  );
  useEffect(() => {
    if (!isMac) return;
    // Commands change in bursts (a file opening registers many): once settled.
    const timer = setTimeout(
      () => void call("set_native_menu", { menus: toNative(menus) }).catch(() => {}),
      150,
    );
    return () => clearTimeout(timer);
  }, [menus]);
  return isMac ? null : <MenuBar menus={menus} onRun={runCommand} />;
}

export function App() {
  const {
    tabs,
    activeId,
    setActive,
    openPaths: openFiles,
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
  const openWorkspace = useWorkspace((s) => s.open);
  const pickWorkspace = useWorkspace((s) => s.pickAndOpen);
  const saveWorkspace = useWorkspace((s) => s.save);
  // Files open in tabs; a workspace file replaces the tabs with its own.
  const openPaths = useMemo(
    () => async (paths: string[]) => {
      const files = paths.filter((p) => !isWorkspacePath(p));
      const ws = paths.filter(isWorkspacePath).at(-1);
      if (ws) await openWorkspace(ws);
      if (files.length > 0) await openFiles(files);
    },
    [openFiles, openWorkspace],
  );

  useEffect(() => {
    void probeEngine();
    void loadApp();
    if (useSettings.getState().checkUpdates) void useUpdate.getState().autoCheck();
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

  const [patternOpen, setPatternOpen] = useState(false);
  const [help, setHelp] = useState<HelpTopic | null>(null);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const startNewWorkspace = useWorkspace((s) => s.startNew);
  const clearRecent = useRecent((s) => s.clear);
  // Open URL, and whether it starts on the S3 settings.
  const [urlOpen, setUrlOpen] = useState<{ s3: boolean } | null>(null);
  const openFolder = useMemo(
    () => async () => {
      const dir = await pickFolder().catch(() => null);
      if (dir) await openPaths([dir]);
    },
    [openPaths],
  );
  const openSample = useMemo(
    () => async () => {
      try {
        await openPaths([await sampleDataset()]);
      } catch (err) {
        notice(
          `Couldn't make the sample dataset: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [openPaths, notice],
  );

  const shortcuts = useMemo(
    () => ({
      openFile: () => void openFile(),
      openFolder: () => void openFolder(),
      closeTab: () => {
        const id = useTabs.getState().activeId;
        if (id) close(id);
      },
      nextTab: () => cycle(1),
      previousTab: () => cycle(-1),
      commandPalette: () => setPalette({ query: "" }),
      copyAs: () => setPalette({ query: "Copy " }),
      saveWorkspace: () => void saveWorkspace(),
      saveWorkspaceAs: () => void saveWorkspace(true),
      newWorkspace: startNewWorkspace,
      settings: () => setSettingsOpen(true),
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
    [
      openFile,
      openFolder,
      close,
      cycle,
      setSqlOpen,
      saveWorkspace,
      startNewWorkspace,
      setSettingsOpen,
    ],
  );
  useShortcuts(shortcuts);

  // App-wide commands; the open file adds its own (FileView).
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "new-workspace",
        title: "New workspace",
        group: "File",
        shortcut: `${modKey}+N`,
        keywords: "close all tabs start fresh empty",
        run: shortcuts.newWorkspace,
      },
      {
        id: "open-file",
        title: "Open file…",
        group: "File",
        shortcut: `${modKey}+O`,
        run: shortcuts.openFile,
      },
      {
        id: "open-folder",
        title: "Open folder as one table…",
        group: "File",
        shortcut: `Shift+${modKey}+O`,
        keywords: "directory many files combine union",
        run: shortcuts.openFolder,
      },
      {
        id: "open-pattern",
        title: "Open files matching a pattern…",
        group: "File",
        keywords: "glob wildcard folder many files combine union *.csv",
        run: () => setPatternOpen(true),
      },
      {
        id: "open-workspace",
        title: "Open workspace…",
        group: "File",
        keywords: "project session restore tabs load",
        run: () => void pickWorkspace(),
      },
      {
        id: "save-workspace",
        title: "Save workspace",
        group: "File",
        shortcut: `${modKey}+S`,
        keywords: "project session tabs keep store",
        run: shortcuts.saveWorkspace,
      },
      {
        id: "save-workspace-as",
        title: "Save workspace as…",
        group: "File",
        shortcut: `Shift+${modKey}+S`,
        keywords: "project session tabs keep store copy",
        run: shortcuts.saveWorkspaceAs,
      },
      {
        id: "open-url",
        title: "Open URL…",
        group: "File",
        keywords: "http https web download s3 bucket remote cloud",
        run: () => setUrlOpen({ s3: false }),
      },
      {
        id: "s3-settings",
        title: "S3 settings…",
        group: "File",
        keywords: "aws minio r2 credentials keychain bucket remote cloud",
        run: () => setUrlOpen({ s3: true }),
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
    if (recent.length > 0)
      list.push({
        id: "clear-recent",
        title: "Clear recent files",
        group: "File",
        keywords: "history forget",
        run: clearRecent,
      });
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
      {
        id: "settings",
        title: "Settings…",
        group: "App",
        shortcut: `${modKey}+,`,
        keywords: "preferences options memory cache theme density export",
        run: shortcuts.settings,
      },
      {
        id: "command-palette",
        title: "Command palette…",
        group: "App",
        shortcut: `${modKey}+K`,
        keywords: "actions search commands",
        run: shortcuts.commandPalette,
      },
      {
        id: "open-sample",
        title: "Open the sample dataset",
        group: "Help",
        keywords: "example demo try orders",
        run: () => void openSample(),
      },
      {
        id: "show-tips",
        title: "Show getting-started tips",
        group: "Help",
        keywords: "onboarding help intro",
        run: () => setHelp("tips"),
      },
      {
        id: "check-updates",
        title: "Check for updates",
        group: "Help",
        keywords: "new version upgrade install",
        run: () => void useUpdate.getState().check(),
      },
      {
        id: "keyboard-shortcuts",
        title: "Keyboard shortcuts",
        group: "Help",
        keywords: "keys hotkeys",
        run: () => setHelp("shortcuts"),
      },
      {
        id: "about",
        title: "About BigView",
        group: "Help",
        keywords: "version",
        run: () => setHelp("about"),
      },
    );
    if (!isMac)
      list.push({
        id: "exit",
        title: "Exit",
        group: "App",
        keywords: "quit close app",
        run: () => void import("@tauri-apps/api/window").then((w) => w.getCurrentWindow().close()),
      });
    return list;
  }, [
    shortcuts,
    openSample,
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
    pickWorkspace,
    clearRecent,
  ]);
  useRegisterCommands("app", commands);

  useSubscription(useMemo(() => () => onImportProgress(applyProgress), [applyProgress]));
  useSubscription(useMemo(() => () => onViewReady(applyViewReady), [applyViewReady]));
  // A second `bigview <files>` launch forwards its files here.
  useSubscription(useMemo(() => () => onOpenFiles((p) => void openPaths(p)), [openPaths]));
  useSubscription(
    useMemo(
      () => () =>
        // The native macOS menu: every item is a command (see `MENUS`).
        onMenu(runCommand),
      [],
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
        menu={isMac ? undefined : <AppMenus />}
        panels={{ left: sidebar, right: profileOpen, bottom: sqlOpen }}
        onTogglePanel={(panel) =>
          panel === "left"
            ? shortcuts.toggleSidebar()
            : panel === "right"
              ? shortcuts.toggleProfile()
              : shortcuts.toggleSql()
        }
      />
      <OpenPattern
        // A fresh box each time.
        key={patternOpen ? "open" : "closed"}
        open={patternOpen}
        onOpenChange={setPatternOpen}
        onOpen={(p) => void openPaths([p])}
      />
      <OpenUrl
        key={urlOpen ? `open:${urlOpen.s3}` : "closed"}
        open={urlOpen !== null}
        onOpenChange={(o) => !o && setUrlOpen(null)}
        showS3={urlOpen?.s3}
        onOpen={(u) => void openPaths([u])}
      />
      {isMac && <AppMenus />}
      <SettingsDialog />
      <HelpDialog topic={help} onClose={() => setHelp(null)} />
      <UpdateDialog />
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
              onOpenFolder={() => void openFolder()}
              onOpenSample={() => void openSample()}
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
