import type { Command } from "../stores/commands";
import { COPY_FORMATS } from "./copyAs";

/**
 * The menu bar (D47): every item is a command of the palette, by id, so the
 * menus, the palette and the shortcuts always do the same thing. An item
 * whose command isn't there right now (no file open, …) is shown disabled.
 */
export type MenuEntry =
  /**
   * `label` is used when the command isn't registered (its title otherwise),
   * or always when `fixed` (inside a submenu that already says what it is).
   */
  | { command: string; label: string; fixed?: boolean }
  | { separator: true }
  | { submenu: string; items: MenuEntry[] }
  /** The recent files, then "Clear recent files". */
  | { recent: true };

export interface MenuSpec {
  label: string;
  items: MenuEntry[];
}

const sep = { separator: true } as const;

export const MENUS: MenuSpec[] = [
  {
    label: "File",
    items: [
      { command: "new-workspace", label: "New workspace" },
      sep,
      { command: "open-file", label: "Open file…" },
      { command: "open-folder", label: "Open folder as one table…" },
      { command: "open-pattern", label: "Open files matching a pattern…" },
      { command: "open-url", label: "Open URL…" },
      { submenu: "Open recent", items: [{ recent: true }] },
      sep,
      { command: "open-workspace", label: "Open workspace…" },
      { command: "save-workspace", label: "Save workspace" },
      { command: "save-workspace-as", label: "Save workspace as…" },
      sep,
      { command: "export", label: "Export view…" },
      { command: "reload-file", label: "Reload file (keep filters)" },
      sep,
      { command: "settings", label: "Settings…" },
      sep,
      { command: "close-tab", label: "Close tab" },
      { command: "exit", label: "Exit" },
    ],
  },
  {
    label: "Edit",
    items: [
      { command: "undo-clean", label: "Undo cleaning step" },
      { command: "redo-clean", label: "Redo cleaning step" },
      sep,
      {
        submenu: "Copy selection as",
        items: COPY_FORMATS.map((f) => ({
          command: `copy-${f.format}`,
          label: f.label,
          fixed: true,
        })),
      },
      { command: "copy-view-sql", label: "Copy view as SQL" },
      sep,
      { command: "search", label: "Search in data" },
      { command: "go-to-row", label: "Go to row…" },
      sep,
      { command: "clear-filters", label: "Clear filters" },
      { command: "clear-search", label: "Clear search" },
      { command: "show-all-columns", label: "Show all columns" },
    ],
  },
  {
    label: "View",
    items: [
      { command: "command-palette", label: "Command palette…" },
      sep,
      { command: "toggle-sidebar", label: "Show sidebar" },
      { command: "toggle-profile", label: "Show column profile panel" },
      { command: "toggle-sql", label: "Show SQL panel" },
      sep,
      { command: "show-grid", label: "Show the grid" },
      { command: "show-chart", label: "Show a chart of the view" },
      { command: "header-charts", label: "Show column histograms" },
      sep,
      {
        submenu: "Theme",
        items: [
          { command: "theme-system", label: "Follow system", fixed: true },
          { command: "theme-light", label: "Light", fixed: true },
          { command: "theme-dark", label: "Dark", fixed: true },
        ],
      },
      sep,
      { command: "next-tab", label: "Next tab" },
      { command: "previous-tab", label: "Previous tab" },
    ],
  },
  {
    label: "Data",
    items: [
      { command: "clean", label: "Clean data…" },
      { command: "quality", label: "Check data quality" },
      { command: "compare", label: "Compare with another file…" },
      sep,
      { command: "open-view-sql", label: "Open view in SQL panel" },
      { command: "run-sql", label: "Run SQL (or the selection)" },
      { command: "format-sql", label: "Format SQL" },
      { command: "sql-history", label: "SQL history…" },
      { command: "saved-queries", label: "Saved queries…" },
      sep,
      { command: "load-recipe", label: "Load recipe…" },
      { command: "save-recipe", label: "Save recipe…" },
      { command: "export-recipe-sql", label: "Export recipe as SQL…" },
      sep,
      { command: "s3-settings", label: "S3 settings…" },
      { command: "clear-cache", label: "Clear cache" },
    ],
  },
  {
    label: "Help",
    items: [
      { command: "keyboard-shortcuts", label: "Keyboard shortcuts" },
      { command: "about", label: "About BigView" },
    ],
  },
];

/** macOS has Settings in the app menu and Quit there; no Exit item. */
const MAC_ONLY_ELSEWHERE = new Set(["settings", "exit"]);

/**
 * Native macOS shortcuts. A native shortcut takes the key from the web view,
 * so only app-wide ones (handled the same everywhere through the menu) get
 * one; the others stay with the page and show in the palette.
 */
export const MAC_ACCELERATORS: Record<string, string> = {
  "new-workspace": "CmdOrCtrl+N",
  "open-file": "CmdOrCtrl+O",
  "open-folder": "CmdOrCtrl+Shift+O",
  "save-workspace": "CmdOrCtrl+S",
  "save-workspace-as": "CmdOrCtrl+Shift+S",
  "close-tab": "CmdOrCtrl+W",
};

export type ResolvedItem =
  | { kind: "item"; id: string; label: string; shortcut?: string; enabled: boolean }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; items: ResolvedItem[] };

export interface ResolvedMenu {
  label: string;
  items: ResolvedItem[];
}

/** No separator first, last or twice in a row. */
function tidy(items: ResolvedItem[]): ResolvedItem[] {
  const out: ResolvedItem[] = [];
  for (const item of items) {
    if (item.kind === "separator" && (out.length === 0 || out.at(-1)?.kind === "separator"))
      continue;
    out.push(item);
  }
  while (out.at(-1)?.kind === "separator") out.pop();
  return out;
}

/** The folder a file is in (`…/data/a.csv` → `data`), or a URL's host. */
export function whereIs(path: string): string {
  const url = /^[a-z0-9]+:\/\/([^/]+)/i.exec(path);
  if (url) return url[1]!;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-2) ?? path;
}

/** The menus as they are now: titles, shortcuts and what can be used. */
export function resolveMenus(
  specs: MenuSpec[],
  commands: Command[],
  recent: { path: string; name: string }[],
  mac: boolean,
): ResolvedMenu[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const resolve = (entries: MenuEntry[]): ResolvedItem[] =>
    tidy(
      entries.flatMap((e): ResolvedItem[] => {
        if ("separator" in e) return [{ kind: "separator" }];
        if ("submenu" in e) return [{ kind: "submenu", label: e.submenu, items: resolve(e.items) }];
        if ("recent" in e) {
          // Two files of the same name: say where each is.
          const counts = new Map<string, number>();
          for (const f of recent) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
          const label = (f: { path: string; name: string }) =>
            (counts.get(f.name) ?? 0) > 1 ? `${f.name} — ${whereIs(f.path)}` : f.name;
          if (recent.length === 0)
            return [{ kind: "item", id: "no-recent", label: "No recent files", enabled: false }];
          return [
            ...recent.map((f): ResolvedItem => ({
              kind: "item",
              id: `recent:${f.path}`,
              label: label(f),
              enabled: byId.has(`recent:${f.path}`),
            })),
            { kind: "separator" },
            {
              kind: "item",
              id: "clear-recent",
              label: "Clear recent files",
              enabled: byId.has("clear-recent"),
            },
          ];
        }
        if (mac && MAC_ONLY_ELSEWHERE.has(e.command)) return [];
        const c = byId.get(e.command);
        return [
          {
            kind: "item",
            id: e.command,
            label: e.fixed || !c ? e.label : c.title,
            shortcut: c?.shortcut,
            enabled: Boolean(c),
          },
        ];
      }),
    );
  return specs.map((m) => ({ label: m.label, items: resolve(m.items) }));
}

/** The shape the backend builds the macOS menu bar from (`menu::NativeMenu`). */
export type NativeItem =
  | { kind: "item"; id: string; label: string; accelerator: string | null; enabled: boolean }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; items: NativeItem[] };

export function toNative(menus: ResolvedMenu[]): { label: string; items: NativeItem[] }[] {
  const convert = (items: ResolvedItem[]): NativeItem[] =>
    items.map((i) =>
      i.kind === "item"
        ? {
            kind: "item",
            id: i.id,
            label: i.label,
            accelerator: MAC_ACCELERATORS[i.id] ?? null,
            enabled: i.enabled,
          }
        : i.kind === "submenu"
          ? { kind: "submenu", label: i.label, items: convert(i.items) }
          : i,
    );
  return menus.map((m) => ({ label: m.label, items: convert(m.items) }));
}
