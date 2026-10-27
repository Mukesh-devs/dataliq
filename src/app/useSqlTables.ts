import { useEffect, useMemo, useRef } from "react";
import {
  CURRENT_VIEW,
  cleanTableName,
  registerTable,
  uniqueNames,
  unregisterTable,
} from "../lib/sql";
import { useSql, type SqlTable } from "../stores/sql";
import type { Tab } from "../stores/tabs";

/**
 * Each tab with full data, as a table name: the name chosen for it, else
 * one made from the file name; unique (case-insensitively, as SQL compares
 * names) in tab order, chosen names first.
 */
export function tableNames(tabs: Tab[]): { tab: Tab; name: string; datasetId: string }[] {
  const ready = tabs.filter((t) => t.info?.dataset);
  const chosen = ready.flatMap((t) => (t.sqlName ? [t.sqlName] : []));
  const unnamed = ready.filter((t) => !t.sqlName);
  const auto = uniqueNames(
    unnamed.map((t) => cleanTableName(t.title)),
    [CURRENT_VIEW, ...chosen],
  );
  const autoOf = new Map(unnamed.map((t, i) => [t.id, auto[i]!]));
  return ready.map((tab) => ({
    tab,
    name: tab.sqlName ?? autoOf.get(tab.id)!,
    datasetId: tab.info!.dataset!.id,
  }));
}

/**
 * Keeps the backend's SQL tables in step with the open tabs (register new
 * ones, drop closed or renamed ones), points `current_view` at the active
 * tab's view, and gives the SQL panel the names and columns.
 */
export function useSqlTables(tabs: Tab[], activeId: string | null) {
  const setTables = useSql((s) => s.setTables);
  const wanted = useMemo(() => {
    const list = tableNames(tabs).map((w) => ({
      name: w.name,
      datasetId: w.datasetId,
      tabId: w.tab.id,
      columns: (w.tab.info?.columns ?? []).map((c) => c.name),
    }));
    const active = tabs.find((t) => t.id === activeId);
    const base = active?.info?.dataset;
    if (active && base) {
      list.push({
        name: CURRENT_VIEW,
        // The rows on screen: the view's own dataset, else the whole file.
        datasetId: active.viewState?.dataset?.id ?? base.id,
        tabId: active.id,
        columns: (active.info?.columns ?? []).map((c) => c.name),
      });
    }
    return list;
  }, [tabs, activeId]);
  // name -> dataset id currently registered in the backend.
  const registered = useRef(new Map<string, string>());
  const shown = useRef("");

  useEffect(() => {
    const next = new Map(wanted.map((w) => [w.name, w.datasetId]));
    for (const [name, id] of registered.current) {
      if (next.get(name) !== id) {
        registered.current.delete(name);
        if (!next.has(name)) void unregisterTable(name).catch(() => {});
      }
    }
    for (const [name, id] of next) {
      if (registered.current.get(name) === id) continue;
      registered.current.set(name, id);
      void registerTable(id, name).catch(() => registered.current.delete(name));
    }
    const tables: SqlTable[] = wanted.map((w) => ({
      name: w.name,
      columns: w.columns,
      tabId: w.tabId,
      current: w.name === CURRENT_VIEW,
    }));
    // Only a real change reaches the editor (it rebuilds its completions).
    const key = JSON.stringify(tables);
    if (key !== shown.current) {
      shown.current = key;
      setTables(tables);
    }
  }, [wanted, setTables]);
}
