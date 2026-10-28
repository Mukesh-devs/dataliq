import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcBytes, sampleInfo } from "../test/ipc";
import { savedTabs, workspaceFileName, type WorkspaceFile } from "../lib/workspace";
import { defaultLayout } from "../lib/layout";
import { useLayout } from "./layout";
import { useSql } from "./sql";
import { useTabs } from "./tabs";
import { useWorkspace } from "./workspace";

const settle = () => new Promise((r) => setTimeout(r, 0));
const nameFilter = { column: "name", op: "contains" as const, value: "a" };

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** A backend that keeps one saved workspace file, and imports at once. */
function backend(dialog: { save?: string; open?: string } = {}) {
  const calls: Call[] = [];
  let stored: WorkspaceFile | undefined;
  mockIPC(
    (cmd, a) => {
      const args = a as Record<string, unknown>;
      calls.push({ cmd, args });
      switch (cmd) {
        case "open_file":
          return { ...sampleInfo, path: args.path };
        case "preview_file":
          return ipcBytes({ id: [1, 2], name: ["a", "b"] });
        case "import_file":
          return {
            dataset: { id: `ds:${String(args.path)}`, rowCount: 2 },
            fromCache: false,
            elapsedMs: 1,
          };
        case "open_view":
          return { dataset: { id: "view-1", rowCount: 1 }, totalRows: 2, elapsedMs: 1 };
        case "apply_recipe":
          return {
            dataset: { id: "clean-1", rowCount: 2 },
            columns: sampleInfo.columns,
            steps: [],
            elapsedMs: 1,
          };
        case "fetch_rows":
          return ipcBytes({ id: [1, 2], name: ["a", "b"] });
        case "recipe_script":
          return "SELECT * FROM base;";
        case "save_workspace":
          stored = JSON.parse(JSON.stringify(args.workspace)) as WorkspaceFile;
          return null;
        case "load_workspace":
          return stored;
        case "plugin:dialog|save":
          return dialog.save ?? null;
        case "plugin:dialog|open":
          return dialog.open ?? null;
        case "close_dataset":
        case "cancel_import":
        case "cancel_query":
          return true;
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
  return calls;
}

describe("savedTabs", () => {
  it("keeps each file and only what was set on it", () => {
    const out = savedTabs(
      [
        { id: "a", path: "/d/a.csv", options: {}, mode: "grid", info: { format: "csv" } },
        {
          id: "b",
          path: "/d/b.xlsx",
          options: { excel: { sheet: "Q2" } },
          view: { filters: [nameFilter] },
          recipe: [],
          mode: "chart",
          sqlName: "sales",
          info: { format: "xlsx" },
        },
        { id: "c", path: "", compare: {}, info: { format: "csv" } },
        { id: "d", path: "", info: { format: "sql" } },
      ],
      "b",
    );
    expect(out).toEqual({
      tabs: [
        { path: "/d/a.csv" },
        {
          path: "/d/b.xlsx",
          options: { excel: { sheet: "Q2" } },
          view: { filters: [nameFilter] },
          mode: "chart",
          sqlName: "sales",
        },
      ],
      active: 1,
      left: 2,
    });
    // The active tab was left out (a SQL result): none is.
    expect(savedTabs([{ id: "d", path: "", info: { format: "sql" } }], "d").active).toBeNull();
  });

  it("names the file after the first tab", () => {
    expect(workspaceFileName("sales.csv.gz")).toBe("sales.bigview");
    expect(workspaceFileName(undefined)).toBe("workspace.bigview");
  });
});

describe("workspace store", () => {
  beforeEach(() => {
    useTabs.setState({ tabs: [], activeId: null });
    useWorkspace.setState({ path: null });
    useSql.setState({ text: "", open: false });
  });
  afterEach(() => clearMocks());

  it("saves the tabs and SQL panel, and opens them again in their place", async () => {
    const calls = backend({ save: "/w/sales.bigview" });
    await useTabs.getState().openPaths(["/data/a.csv", "/data/b.csv"]);
    await settle();
    const [a, b] = useTabs.getState().tabs;
    await useTabs.getState().setView(a!.id, { filters: [nameFilter] });
    useTabs.getState().setLayout(b!.id, { ...defaultLayout(["id", "name"]), hidden: ["id"] });
    useTabs.getState().setSqlName(b!.id, "bees");
    await useTabs.getState().setRecipe(b!.id, [{ op: "trim", column: "name" }]);
    useTabs.getState().setActive(a!.id);
    useSql.setState({ text: "SELECT * FROM bees", open: true, height: 300 });
    useLayout.getState().setProfile(false);

    await useWorkspace.getState().save();
    const saved = calls.find((c) => c.cmd === "save_workspace")!;
    expect(saved.args.path).toBe("/w/sales.bigview");
    expect(saved.args.workspace).toMatchObject({
      active: 0,
      tabs: [
        { path: "/data/a.csv", view: { filters: [nameFilter] } },
        {
          path: "/data/b.csv",
          layout: { hidden: ["id"] },
          sqlName: "bees",
          recipe: [{ op: "trim", column: "name" }],
        },
      ],
      sql: { text: "SELECT * FROM bees", open: true, height: 300 },
      panels: { profile: false },
    });
    // Saving again writes the same file without asking.
    await useWorkspace.getState().save();
    expect(calls.filter((c) => c.cmd === "plugin:dialog|save")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "save_workspace")).toHaveLength(2);

    // Something else is open now; the workspace replaces it.
    await useTabs.getState().openPath("/data/other.csv");
    useSql.setState({ text: "", open: false });
    await useWorkspace.getState().open("/w/sales.bigview");
    await settle();
    await settle();
    const tabs = useTabs.getState().tabs;
    expect(tabs.map((t) => t.path)).toEqual(["/data/a.csv", "/data/b.csv"]);
    expect(useTabs.getState().activeId).toBe(tabs[0]!.id);
    expect(tabs[0]!.view).toEqual({ filters: [nameFilter] });
    expect(tabs[0]!.viewState?.status).toBe("done");
    expect(tabs[1]!).toMatchObject({ layout: { hidden: ["id"] }, sqlName: "bees" });
    expect(tabs[1]!.recipeState?.status).toBe("done");
    expect(useSql.getState()).toMatchObject({ text: "SELECT * FROM bees", open: true });
    // The replaced tab's data was let go.
    const closed = calls.filter((c) => c.cmd === "close_dataset").map((c) => c.args.datasetId);
    expect(closed).toContain("ds:/data/other.csv");
  });
});
