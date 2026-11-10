import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ColumnMeta } from "../../lib/files";
import {
  joinSql,
  pivotSql,
  sampleSql,
  summarySql,
  unionSql,
  valueCountsSql,
} from "../../lib/tools";
import type { Command } from "../../stores/commands";
import { useNotice } from "../../stores/notice";
import { baseOf, useTabs, type Tab } from "../../stores/tabs";
import type { CompareSide } from "../compare/CompareDialog";
import { AppendDialog } from "./AppendDialog";
import { JoinDialog } from "./JoinDialog";
import { PivotDialog } from "./PivotDialog";
import { SampleDialog } from "./SampleDialog";
import { hasView, openQueryTab, tabSource } from "./run";

type Open =
  | { tool: "pivot"; group?: string }
  | { tool: "sample" }
  | { tool: "append"; others: CompareSide[] }
  | { tool: "join"; others: CompareSide[] };

const sideOf = (t: Tab): CompareSide => ({
  tabId: t.id,
  title: t.title,
  columns: baseOf(t).columns,
});

/** The other tabs whose data is ready. */
function otherTabs(tab: Tab): CompareSide[] {
  return useTabs
    .getState()
    .tabs.filter((t) => t.id !== tab.id && t.status === "ready" && baseOf(t).dataset)
    .map(sideOf);
}

function short(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Group by / pivot, value counts, samples, append, join and a summary of
 * every column, for one tab: palette commands, column-menu actions and the
 * dialogs to render. Each result opens as a new tab.
 */
export function useDataTools(tab: Tab, rowCount: number | undefined) {
  const [open, setOpen] = useState<Open | null>(null);
  const notice = useNotice((s) => s.show);
  const columns: ColumnMeta[] = baseOf(tab).columns;
  const ready = tab.status === "ready" && !!baseOf(tab).dataset;
  const viewed = hasView(tab);

  /** Runs a query-building tool without a dialog, saying what it does. */
  const runQuick = useCallback(
    async (what: string, build: (src: string) => string, title: string) => {
      try {
        await openQueryTab(build(await tabSource(tab, true)), title, what);
      } catch (e) {
        if ((e as { kind?: string }).kind === "cancelled") return;
        notice(`Couldn't finish: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [tab, notice],
  );

  const countValues = useCallback(
    (column: string) =>
      void runQuick(
        `Counting the values of ${column}`,
        (src) => valueCountsSql(src, column),
        short(`${column} counts · ${tab.title}`),
      ),
    [runQuick, tab.title],
  );
  const summarize = useCallback(
    () =>
      void runQuick(
        "Summarizing every column",
        (src) => summarySql(src),
        short(`Summary · ${tab.title}`),
      ),
    [runQuick, tab.title],
  );
  const groupBy = useCallback((column?: string) => setOpen({ tool: "pivot", group: column }), []);

  const commands = useMemo<Command[]>(() => {
    if (!ready) return [];
    return [
      {
        id: "group-by",
        title: "Group by / pivot…",
        group: "Data",
        keywords: "aggregate sum count average totals pivot table",
        run: () => setOpen({ tool: "pivot" }),
      },
      {
        id: "summarize-columns",
        title: "Summarize every column",
        group: "Data",
        keywords: "summary describe statistics min max nulls quartiles",
        run: summarize,
      },
      {
        id: "sample-rows",
        title: "Open a sample…",
        group: "Data",
        keywords: "random subset reservoir percent first rows",
        run: () => setOpen({ tool: "sample" }),
      },
      {
        id: "append-tabs",
        title: "Append tabs…",
        group: "Data",
        keywords: "union stack combine concatenate files",
        run: () => setOpen({ tool: "append", others: otherTabs(tab) }),
      },
      {
        id: "join-tabs",
        title: "Join with another tab…",
        group: "Data",
        keywords: "merge lookup vlookup match combine",
        run: () => setOpen({ tool: "join", others: otherTabs(tab) }),
      },
    ];
  }, [ready, summarize, tab]);

  const close = useCallback(() => setOpen(null), []);
  let dialogs: ReactNode = null;
  if (open?.tool === "pivot") {
    dialogs = (
      <PivotDialog
        columns={columns}
        hasView={viewed}
        initialGroup={open.group}
        onClose={close}
        onRun={async (spec, withView) => {
          const by = spec.groups.length > 0 ? `by ${spec.groups.join(", ")}` : "totals";
          await openQueryTab(
            pivotSql(await tabSource(tab, withView), spec),
            short(`${tab.title} ${by}`),
            `Grouping ${tab.title} ${by}`,
          );
        }}
      />
    );
  } else if (open?.tool === "sample") {
    dialogs = (
      <SampleDialog
        rowCount={rowCount}
        hasView={viewed}
        onClose={close}
        onRun={async (spec, withView) =>
          openQueryTab(
            sampleSql(await tabSource(tab, withView), spec),
            short(`Sample · ${tab.title}`),
            `Sampling ${tab.title}`,
          )
        }
      />
    );
  } else if (open?.tool === "append") {
    dialogs = (
      <AppendDialog
        current={sideOf(tab)}
        others={open.others}
        onClose={close}
        onRun={async (ids, sourceColumn) => {
          const all = useTabs.getState().tabs;
          const parts = await Promise.all(
            ids.map(async (id) => {
              const t = all.find((x) => x.id === id);
              if (!t) throw new Error("A tab was closed.");
              return { src: await tabSource(t, true), label: t.title };
            }),
          );
          await openQueryTab(
            unionSql(parts, sourceColumn),
            short(parts.map((p) => p.label).join(" + ")),
            `Appending ${parts.length} tabs`,
          );
        }}
      />
    );
  } else if (open?.tool === "join") {
    dialogs = (
      <JoinDialog
        current={sideOf(tab)}
        others={open.others}
        hasView={viewed}
        onClose={close}
        onRun={async ({ rightTabId, kind, keys, withView }) => {
          const right = useTabs.getState().tabs.find((t) => t.id === rightTabId);
          if (!right) throw new Error("The other tab was closed.");
          const sql = joinSql(await tabSource(tab, withView), await tabSource(right, withView), {
            kind,
            keys,
            leftColumns: columns.map((c) => c.name),
            rightColumns: baseOf(right).columns.map((c) => c.name),
          });
          await openQueryTab(
            sql,
            short(`${tab.title} ⋈ ${right.title}`),
            `Joining ${tab.title} with ${right.title}`,
          );
        }}
      />
    );
  }

  return { commands, dialogs, countValues, groupBy: ready ? groupBy : undefined, ready };
}
