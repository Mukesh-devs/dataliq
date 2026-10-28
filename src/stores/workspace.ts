import { create } from "zustand";
import { baseName } from "../lib/files";
import { plural } from "../lib/format";
import {
  loadWorkspace,
  pickWorkspaceOpen,
  pickWorkspaceSave,
  saveWorkspace,
  savedTabs,
  workspaceFileName,
  type WorkspaceFile,
} from "../lib/workspace";
import { useLayout } from "./layout";
import { useNotice } from "./notice";
import { useRecent } from "./recent";
import { useSql } from "./sql";
import { useTabs } from "./tabs";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface WorkspaceState {
  /** The workspace file last opened or saved; Save writes it again. */
  path: string | null;
  /** Saves the tabs, SQL panel and side panels (asking where, `as` or the first time). */
  save: (as?: boolean) => Promise<void>;
  /** Asks for a workspace file and opens it. */
  pickAndOpen: () => Promise<void>;
  /** Replaces the open tabs, SQL text and panels with the workspace's. */
  open: (path: string) => Promise<void>;
}

/** What is on screen now, as a workspace. */
function current(): { workspace: WorkspaceFile; left: number } {
  const { tabs, activeId } = useTabs.getState();
  const saved = savedTabs(tabs, activeId);
  const sql = useSql.getState();
  const layout = useLayout.getState();
  return {
    workspace: {
      tabs: saved.tabs,
      active: saved.active,
      sql: { text: sql.text, open: sql.open, height: sql.height },
      panels: { sidebar: layout.sidebar, profile: layout.profile },
    },
    left: saved.left,
  };
}

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  path: null,
  save: async (as = false) => {
    const notice = useNotice.getState().show;
    const { workspace, left } = current();
    let path = as ? null : get().path;
    if (!path) {
      const first = useTabs.getState().tabs[0]?.title;
      path = await pickWorkspaceSave(get().path ?? workspaceFileName(first)).catch(() => null);
      if (!path) return;
    }
    try {
      await saveWorkspace(path, workspace);
      set({ path });
      useRecent.getState().add(path);
      notice(
        `Workspace saved: ${baseName(path)}` +
          (left ? ` (${plural(left, "comparison or SQL result tab")} left out)` : ""),
      );
    } catch (err) {
      notice(`Couldn't save the workspace: ${errorText(err)}`);
    }
  },
  pickAndOpen: async () => {
    const path = await pickWorkspaceOpen().catch(() => null);
    if (path) await get().open(path);
  },
  open: async (path) => {
    const notice = useNotice.getState().show;
    let ws: WorkspaceFile;
    try {
      ws = await loadWorkspace(path);
    } catch (err) {
      notice(`Couldn't open the workspace: ${errorText(err)}`);
      return;
    }
    set({ path });
    useRecent.getState().add(path);
    if (ws.sql) {
      const sql = useSql.getState();
      // The mounted editor shows the text; otherwise it starts with it.
      if (sql.editor) sql.editor.replace(ws.sql.text);
      sql.setText(ws.sql.text);
      if (ws.sql.height) sql.setHeight(ws.sql.height);
      sql.setOpen(ws.sql.open);
    }
    if (ws.panels) {
      const layout = useLayout.getState();
      layout.setSidebar(ws.panels.sidebar);
      layout.setProfile(ws.panels.profile);
    }
    notice(`Workspace opened: ${baseName(path)} (${plural(ws.tabs.length, "tab")})`);
    await useTabs.getState().restore(ws.tabs, ws.active ?? null);
  },
}));
