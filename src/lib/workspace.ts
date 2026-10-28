import type { ChartSpec } from "./chart";
import { call } from "./ipc";
import type { OpenOptions } from "./files";
import type { ColumnLayout } from "./layout";
import type { RecipeStep } from "./recipe";
import type { ViewSpec } from "./view";

/** A workspace file's extension. */
export const WORKSPACE_EXTENSION = "dataliq";

export const isWorkspacePath = (path: string) => /\.dataliq$/i.test(path);

/** A tab as saved in a workspace: its file and what was set on it. */
export interface SavedTab {
  /** Absolute path or URL; on loading, where the file was found. */
  path: string;
  /** Written by the backend: the path from the workspace's folder. */
  relative?: string;
  options?: OpenOptions;
  view?: ViewSpec;
  layout?: ColumnLayout;
  recipe?: RecipeStep[];
  chart?: ChartSpec;
  mode?: "grid" | "chart";
  sqlName?: string;
  recipeOpen?: boolean;
  qualityOpen?: boolean;
}

/** Mirrors `WorkspaceFile` in src-tauri/src/workspace. */
export interface WorkspaceFile {
  format?: string;
  version?: number;
  tabs: SavedTab[];
  /** The tab shown, by position. */
  active?: number | null;
  sql?: { text: string; open: boolean; height?: number } | null;
  panels?: { sidebar: boolean; profile: boolean } | null;
}

/** The parts of a tab a workspace keeps (see `Tab` in stores/tabs). */
interface TabLike extends Omit<SavedTab, "relative"> {
  id: string;
  /** Comparisons and SQL results have no file to open again. */
  compare?: unknown;
  info?: { format: string };
}

/** Tabs that can be saved (a file behind them) and how many can't. */
export function savedTabs(
  tabs: TabLike[],
  activeId: string | null,
): { tabs: SavedTab[]; active: number | null; left: number } {
  const kept = tabs.filter((t) => !t.compare && t.info?.format !== "sql");
  const saved = kept.map((t) => {
    const out: SavedTab = { path: t.path };
    // Only what is set: the file stays readable and small.
    if (t.options && Object.keys(t.options).length) out.options = t.options;
    if (t.view) out.view = t.view;
    if (t.layout) out.layout = t.layout;
    if (t.recipe?.length) out.recipe = t.recipe;
    if (t.chart) out.chart = t.chart;
    if (t.mode && t.mode !== "grid") out.mode = t.mode;
    if (t.sqlName) out.sqlName = t.sqlName;
    if (t.recipeOpen) out.recipeOpen = true;
    if (t.qualityOpen) out.qualityOpen = true;
    return out;
  });
  const active = kept.findIndex((t) => t.id === activeId);
  return { tabs: saved, active: active >= 0 ? active : null, left: tabs.length - kept.length };
}

export function saveWorkspace(path: string, workspace: WorkspaceFile): Promise<void> {
  return call("save_workspace", { path, workspace });
}

export function loadWorkspace(path: string): Promise<WorkspaceFile> {
  return call("load_workspace", { path });
}

/** `sales.csv` → `sales.dataliq`; no tabs → `workspace.dataliq`. */
export function workspaceFileName(firstTitle: string | undefined): string {
  const base = (firstTitle ?? "").split(/[\\/]/).pop()?.split(".")[0]?.trim();
  return `${base || "workspace"}.${WORKSPACE_EXTENSION}`;
}

export async function pickWorkspaceSave(name: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: name,
    filters: [{ name: "DataLiq workspace", extensions: [WORKSPACE_EXTENSION] }],
  });
}

export async function pickWorkspaceOpen(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "DataLiq workspace", extensions: [WORKSPACE_EXTENSION] }],
  });
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}
