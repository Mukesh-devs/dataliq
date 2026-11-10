import { quoteIdent } from "../../lib/copyAs";
import { fetchRows } from "../../lib/files";
import { sqlResult } from "../../lib/sql";
import { asSource } from "../../lib/tools";
import { isIdentity, viewSql } from "../../lib/view";
import { asJob, toolRequestId } from "../../stores/jobs";
import { useSql } from "../../stores/sql";
import { baseOf, useTabs, type Tab } from "../../stores/tabs";

/** Rows of a tool's result shown at once (the rest is paged). */
const PREVIEW_ROWS = 1_000;

/** The SQL panel's table name of a tab, if its data is ready. */
export function tableOf(tab: Tab): string | undefined {
  return useSql.getState().tables.find((t) => t.tabId === tab.id && t.name !== "current_view")
    ?.name;
}

/**
 * A tab's rows as a FROM item for a tool: its SQL table, or with
 * `withView` the view's filters, search and sort applied to it.
 */
export async function tabSource(tab: Tab, withView: boolean): Promise<string> {
  const table = tableOf(tab);
  const dataset = baseOf(tab).dataset;
  if (!table || !dataset) throw new Error(`The data of ${tab.title} isn't ready yet.`);
  const view = tab.view ?? {};
  if (!withView || isIdentity({ ...view, columns: undefined })) return quoteIdent(table);
  const sql = await viewSql(dataset.id, { ...view, columns: undefined }, quoteIdent(table), {});
  return asSource(sql);
}

/** True when the tab's view filters or reorders its rows. */
export function hasView(tab: Tab): boolean {
  return !isIdentity({ ...(tab.view ?? {}), columns: undefined });
}

/**
 * Runs `sql` in the SQL session (where every tab is a table) and opens its
 * rows as a new tab called `title`. Tool queries have their own group, so
 * they never cancel the SQL panel's query (or each other's, but the newest).
 * While it runs, the status bar shows `what` with a timer and Stop.
 */
export async function openQueryTab(sql: string, title: string, what = title): Promise<void> {
  const requestId = toolRequestId("tool");
  await asJob(what, requestId, async () => {
    const dataset = await sqlResult(sql, requestId, "tools");
    const preview = await fetchRows(dataset.id, 0, PREVIEW_ROWS);
    useTabs.getState().openResult({ dataset, preview, sql, title });
  });
}
