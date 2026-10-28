import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcBytes, sampleInfo } from "../test/ipc";
import type { RecipeStep } from "../lib/recipe";
import { baseOf, useTabs } from "./tabs";

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const file = { id: "ds1", rowCount: 1000, cached: true };
const trim: RecipeStep = { op: "trim", column: "name" };
const rename: RecipeStep = { op: "rename", column: "name", to: "full name" };

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** A backend whose recipes rename `name` when asked to. */
function backend() {
  const calls: Call[] = [];
  let next = 1;
  mockIPC(
    (cmd, a) => {
      const args = a as Record<string, unknown>;
      calls.push({ cmd, args });
      switch (cmd) {
        case "open_file":
          return sampleInfo;
        case "preview_file":
          return ipcBytes({ id: [1, 2, 3], name: ["a", "b", null] });
        case "import_file":
          return { dataset: file, fromCache: false, elapsedMs: 100 };
        case "apply_recipe": {
          const steps = args.steps as RecipeStep[];
          const renamed = steps.some((s) => s.op === "rename" && s.enabled !== false);
          const name = renamed ? "full name" : "name";
          return {
            dataset: { id: `recipe-${next++}`, rowCount: 990, cached: true },
            columns: [
              { name: "id", type: "BIGINT" },
              { name, type: "VARCHAR" },
            ],
            steps: steps.map(() => ({ error: null, failed: null, skipped: false })),
            elapsedMs: 9,
          };
        }
        case "fetch_rows": {
          const recipe = calls.findLast((c) => c.cmd === "apply_recipe")!;
          const renamed = (recipe.args.steps as RecipeStep[]).some((s) => s.op === "rename");
          return ipcBytes({ id: [1, 2], [renamed ? "full name" : "name"]: ["a", "b"] });
        }
        case "recipe_script":
          return "WITH base AS (SELECT * FROM read_csv('x'))\nSELECT * FROM step_1;";
        case "open_view":
          return { dataset: { id: `view-${next++}`, rowCount: 40 }, totalRows: 990, elapsedMs: 3 };
        case "close_dataset":
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

const tab = () => useTabs.getState().tabs[0]!;
const closed = (calls: Call[]) =>
  calls.filter((c) => c.cmd === "close_dataset").map((c) => c.args.datasetId);

describe("tabs store: cleaning recipes", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));
  afterEach(() => clearMocks());

  it("applies the recipe to the file; views, columns and SQL read the cleaned rows", async () => {
    const calls = backend();
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    await useTabs.getState().setRecipe(tab().id, [trim]);
    expect(calls.find((c) => c.cmd === "apply_recipe")!.args).toMatchObject({
      datasetId: "ds1",
      steps: [trim],
      group: `recipe:${tab().id}`,
    });
    const base = baseOf(tab());
    expect(base).toMatchObject({ cleaned: true, dataset: { id: "recipe-1", rowCount: 990 } });
    expect(base.readerSql).toBe(
      "(\nWITH base AS (SELECT * FROM read_csv('x'))\nSELECT * FROM step_1\n)",
    );
    // The script is over the file's own reader.
    expect(calls.find((c) => c.cmd === "recipe_script")!.args).toMatchObject({
      datasetId: "ds1",
      reader: sampleInfo.readerSql,
    });

    // A filter opens over the cleaned rows.
    await useTabs.getState().setView(tab().id, { search: "a" });
    expect(calls.findLast((c) => c.cmd === "open_view")!.args.datasetId).toBe("recipe-1");
  });

  it("a renaming step drops filters on the old name; the new rows replace the old", async () => {
    const calls = backend();
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    await useTabs.getState().setRecipe(tab().id, [trim]);
    await useTabs.getState().setView(tab().id, {
      filters: [{ column: "name", op: "isNull" }],
      search: "a",
    });
    await useTabs.getState().setRecipe(tab().id, [trim, rename]);
    expect(tab().view).toEqual({ filters: [], search: "a", sort: undefined, columns: undefined });
    const view = calls.findLast((c) => c.cmd === "open_view")!.args;
    expect(view).toMatchObject({ datasetId: "recipe-3", spec: { filters: [], search: "a" } });
    expect(baseOf(tab()).columns.map((c) => c.name)).toEqual(["id", "full name"]);
    // The old cleaned rows and the old view are closed once the new are up.
    expect(closed(calls)).toEqual(expect.arrayContaining(["recipe-1", "view-2"]));
    expect(closed(calls)).not.toContain("recipe-3");
  });

  it("undo and redo walk the recipe's history", async () => {
    backend();
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    const s = useTabs.getState();
    await s.setRecipe(tab().id, [trim]);
    await s.setRecipe(tab().id, [trim, rename]);
    await s.undoRecipe(tab().id);
    expect(tab().recipe).toEqual([trim]);
    expect(baseOf(tab()).columns.map((c) => c.name)).toEqual(["id", "name"]);
    await s.undoRecipe(tab().id);
    expect(tab().recipe).toBeUndefined();
    // Back to the file itself.
    expect(baseOf(tab())).toMatchObject({ cleaned: false, dataset: file });
    expect(tab().recipeState).toBeUndefined();
    await s.redoRecipe(tab().id);
    await s.redoRecipe(tab().id);
    expect(tab().recipe).toEqual([trim, rename]);
    expect(tab().recipeHistory?.future).toEqual([]);
    // A new change after an undo drops what could be redone.
    await s.undoRecipe(tab().id);
    await s.setRecipe(tab().id, [trim, { ...trim, column: "id" }]);
    expect(tab().recipeHistory?.future).toEqual([]);
  });

  it("waits for the import, and keeps the steps when the file is read again", async () => {
    const calls = backend();
    await useTabs.getState().openPath("/data/sales.csv.gz");
    // Not imported yet: a recipe set now waits.
    useTabs.setState({
      tabs: [{ ...tab(), info: { ...tab().info!, dataset: null }, import: undefined }],
    });
    await useTabs.getState().setRecipe(tab().id, [trim]);
    expect(tab().recipeState?.status).toBe("waiting");
    await useTabs.getState().reload(tab().id);
    await settle();
    expect(tab().recipe).toEqual([trim]);
    expect(tab().recipeState?.status).toBe("done");
    expect(calls.filter((c) => c.cmd === "apply_recipe")).toHaveLength(1);
  });

  it("closing the tab closes the cleaned rows", async () => {
    const calls = backend();
    await useTabs.getState().openPath("/data/sales.csv.gz");
    await settle();
    await useTabs.getState().setRecipe(tab().id, [trim]);
    useTabs.getState().close(tab().id);
    expect(closed(calls)).toEqual(expect.arrayContaining(["ds1", "recipe-1"]));
  });
});
