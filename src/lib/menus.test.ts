import { describe, expect, it } from "vitest";
import type { Command } from "../stores/commands";
import { MENUS, resolveMenus, toNative, type MenuSpec, type ResolvedItem } from "./menus";

const cmd = (id: string, title = id, shortcut?: string): Command => ({
  id,
  title,
  group: "Test",
  shortcut,
  run: () => {},
});

const labels = (items: ResolvedItem[]) =>
  items.map((i) => (i.kind === "separator" ? "---" : i.label));

describe("menus", () => {
  it("are commands: titles and shortcuts from them, disabled when missing", () => {
    const specs: MenuSpec[] = [
      {
        label: "File",
        items: [
          { command: "open-file", label: "Open file…" },
          { separator: true },
          { command: "export", label: "Export…" },
          { separator: true },
          { separator: true },
          { command: "close-tab", label: "Close tab" },
          { separator: true },
        ],
      },
    ];
    const [file] = resolveMenus(
      specs,
      [cmd("open-file", "Open file…", "Ctrl+O"), cmd("close-tab", "Close tab", "Ctrl+W")],
      [],
      false,
    );
    expect(labels(file!.items)).toEqual(["Open file…", "---", "Export…", "---", "Close tab"]);
    expect(file!.items[0]).toEqual({
      kind: "item",
      id: "open-file",
      label: "Open file…",
      shortcut: "Ctrl+O",
      enabled: true,
    });
    // No file open: Export is there, disabled.
    expect(file!.items[2]).toMatchObject({ id: "export", enabled: false });
  });

  it("list recent files, and leave Settings and Exit to macOS's own menus", () => {
    const recent = [{ path: "/d/a.csv", name: "a.csv" }];
    const commands = [
      cmd("recent:/d/a.csv"),
      cmd("clear-recent"),
      cmd("settings", "Settings…"),
      cmd("exit", "Exit"),
    ];
    const file = (mac: boolean) => resolveMenus(MENUS, commands, recent, mac)[0]!;
    const sub = file(false).items.find((i) => i.kind === "submenu" && i.label === "Open recent");
    expect(sub && sub.kind === "submenu" && labels(sub.items)).toEqual([
      "a.csv",
      "---",
      "Clear recent files",
    ]);
    expect(labels(file(false).items)).toContain("Settings…");
    expect(labels(file(false).items)).toContain("Exit");
    expect(labels(file(true).items)).not.toContain("Settings…");
    expect(labels(file(true).items)).not.toContain("Exit");
    const none = resolveMenus(MENUS, [], [], false)[0]!;
    const empty = none.items.find((i) => i.kind === "submenu" && i.label === "Open recent");
    expect(empty && empty.kind === "submenu" && empty.items).toEqual([
      { kind: "item", id: "no-recent", label: "No recent files", enabled: false },
    ]);
  });

  it("keep short labels inside submenus that say what they are", () => {
    const view = resolveMenus(MENUS, [cmd("theme-dark", "Theme: Dark")], [], false)[2]!;
    const theme = view.items.find((i) => i.kind === "submenu" && i.label === "Theme");
    expect(theme && theme.kind === "submenu" && labels(theme.items)).toEqual([
      "Follow system",
      "Light",
      "Dark",
    ]);
  });

  it("give macOS native shortcuts only to app-wide actions", () => {
    const native = toNative(
      resolveMenus(MENUS, [cmd("save-workspace"), cmd("search", "Find", "Ctrl+F")], [], true),
    );
    const flat = native.flatMap((m) => m.items);
    expect(flat.find((i) => i.kind === "item" && i.id === "save-workspace")).toMatchObject({
      accelerator: "CmdOrCtrl+S",
      enabled: true,
    });
    // Find stays with the page (the native menu would take the key from it).
    expect(native[1]!.items.find((i) => i.kind === "item" && i.id === "search")).toMatchObject({
      accelerator: null,
    });
  });

  it("tell recent files of the same name apart by their folder", () => {
    const recent = [
      { path: "/work/proj/work.dataliq", name: "work.dataliq" },
      { path: "/work/old/work.dataliq", name: "work.dataliq" },
      { path: "https://example.com/a.csv", name: "a.csv" },
      { path: "C:\\data\\a.csv", name: "a.csv" },
      { path: "/d/b.csv", name: "b.csv" },
    ];
    const file = resolveMenus(MENUS, [], recent, false)[0]!;
    const sub = file.items.find((i) => i.kind === "submenu" && i.label === "Open recent");
    expect(sub && sub.kind === "submenu" && labels(sub.items).slice(0, 5)).toEqual([
      "work.dataliq — proj",
      "work.dataliq — old",
      "a.csv — example.com",
      "a.csv — data",
      "b.csv",
    ]);
  });
});
