import { useEffect, useMemo, useRef } from "react";
import { cleanTableName, registerTable, uniqueNames, unregisterTable } from "../lib/sql";
import { useSql, type SqlTable } from "../stores/sql";
import type { Tab } from "../stores/tabs";

/** Each tab with full data, as a table name (unique, in tab order). */
export function tableNames(tabs: Tab[]): { tab: Tab; name: string; datasetId: string }[] {
  const ready = tabs.filter((t) => t.info?.dataset);
  const names = uniqueNames(ready.map((t) => cleanTableName(t.title)));
  return ready.map((tab, i) => ({ tab, name: names[i]!, datasetId: tab.info!.dataset!.id }));
}

/**
 * Keeps the backend's SQL tables in step with the open tabs (register new
 * ones, drop closed ones) and gives the SQL panel their names and columns.
 */
export function useSqlTables(tabs: Tab[]) {
  const setTables = useSql((s) => s.setTables);
  const wanted = useMemo(() => tableNames(tabs), [tabs]);
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
      columns: (w.tab.info?.columns ?? []).map((c) => c.name),
    }));
    // Only a real change reaches the editor (it rebuilds its completions).
    const key = JSON.stringify(tables);
    if (key !== shown.current) {
      shown.current = key;
      setTables(tables);
    }
  }, [wanted, setTables]);
}
