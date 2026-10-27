import { create } from "zustand";
import { persist } from "zustand/middleware";
import { baseName } from "../lib/files";
import { formatCount, formatDuration } from "../lib/format";
import {
  cancelExport,
  exportView,
  onExportProgress,
  type ExportFormat,
  type ExportOptions,
  type ExportRequest,
} from "../lib/exporting";
import type { ViewSpec } from "../lib/view";
import { useNotice } from "./notice";

/** What the export dialog exports: a view of a dataset. */
export interface ExportTarget {
  datasetId: string;
  /** Filters, search and sort; `columns` are the shown columns in order. */
  spec: ViewSpec;
  labels: Record<string, string>;
  /** For the suggested file name. */
  title: string;
  rowCount: number;
  /** The grid's selection, if any: its columns and row ranges. */
  selection?: { columns: string[]; rows: [number, number][] } | null;
}

export interface ExportJob {
  id: string;
  path: string;
  format: ExportFormat;
  percent: number | null;
}

/** Options remembered between exports. */
export interface ExportDefaults {
  format: ExportFormat;
  header: boolean;
  delimiter: string;
  quoteAll: boolean;
  dateFormat: string;
  timestampFormat: string;
  splitSheets: boolean;
}

interface ExportState {
  target: ExportTarget | null;
  job: ExportJob | null;
  defaults: ExportDefaults;
  show: (target: ExportTarget) => void;
  close: () => void;
  setDefaults: (d: Partial<ExportDefaults>) => void;
  /** Runs one export; the outcome is shown as a notice. */
  start: (request: ExportRequest) => Promise<void>;
  cancel: () => void;
}

export const DEFAULTS: ExportDefaults = {
  format: "csv",
  header: true,
  delimiter: ",",
  quoteAll: false,
  dateFormat: "",
  timestampFormat: "",
  splitSheets: true,
};

/** The backend options for `defaults` in `format`. */
export function optionsFor(d: ExportDefaults): ExportOptions {
  const text = (s: string) => (s.trim() ? s : undefined);
  return {
    header: d.header,
    delimiter: d.format === "csv" || d.format === "csvGz" ? d.delimiter : undefined,
    quoteAll: d.quoteAll,
    dateFormat: text(d.dateFormat),
    timestampFormat: text(d.timestampFormat),
    splitSheets: d.splitSheets,
  };
}

let nextJob = 1;
let unlisten: Promise<() => void> | null = null;

export const useExport = create<ExportState>()(
  persist(
    (set, get) => ({
      target: null,
      job: null,
      defaults: DEFAULTS,
      show: (target) => set({ target }),
      close: () => set({ target: null }),
      setDefaults: (d) => set((s) => ({ defaults: { ...s.defaults, ...d } })),
      start: async (request) => {
        if (get().job) return;
        const id = `export-${nextJob++}`;
        set({ job: { id, path: request.path, format: request.format, percent: null } });
        unlisten ??= onExportProgress((p) => {
          const job = get().job;
          if (job && p.jobId === job.id) set({ job: { ...job, percent: p.percent } });
        }).catch(() => () => {});
        const notice = useNotice.getState().show;
        const name = baseName(request.path);
        try {
          const out = await exportView(request, id);
          const rows = `${formatCount(out.rows)} row${out.rows === 1 ? "" : "s"}`;
          const sheets = out.sheets > 1 ? ` on ${out.sheets} sheets` : "";
          const left =
            out.rowsLeftOut > 0
              ? ` (${formatCount(out.rowsLeftOut)} rows past the sheet limit left out)`
              : "";
          notice(`Exported ${rows}${sheets} to ${name} in ${formatDuration(out.elapsedMs)}${left}`);
        } catch (e) {
          if ((e as { kind?: string }).kind === "cancelled") notice("Export cancelled");
          else notice(`Couldn't export: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          set({ job: null });
        }
      },
      cancel: () => {
        const job = get().job;
        if (job) void cancelExport(job.id).catch(() => false);
      },
    }),
    {
      name: "bigview.export",
      partialize: (s) => ({ defaults: s.defaults }),
      merge: (persisted, current) => ({
        ...current,
        defaults: {
          ...DEFAULTS,
          ...((persisted as { defaults?: Partial<ExportDefaults> } | undefined)?.defaults ?? {}),
        },
      }),
    },
  ),
);
