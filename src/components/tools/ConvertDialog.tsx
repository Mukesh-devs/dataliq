import * as Popover from "@radix-ui/react-popover";
import { CircleAlert, CircleCheck, FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CONVERT_FORMATS,
  cancelExport,
  convertFiles,
  convertedName,
  listDataFiles,
  onConvertProgress,
  type ConvertOutcome,
  type ConvertProgress,
  type DataFile,
  type ExportFormat,
} from "../../lib/exporting";
import { baseName, pickFolder } from "../../lib/files";
import { formatBytes, formatDuration, plural } from "../../lib/format";
import { useConvert } from "../../stores/convert";
import { Button } from "../ui/Button";
import { fieldClass, labelClass } from "./ToolDialog";

let nextJob = 1;

/** "Convert files…": a folder of CSV, CSV.gz, JSON or Parquet files to another format. */
export function ConvertDialog() {
  const open = useConvert((s) => s.open);
  const close = useConvert((s) => s.close);
  const [running, setRunning] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={(o) => !o && !running && close()}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Convert files"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 flex max-h-[80vh] w-[32rem] max-w-[92vw] flex-col gap-3 overflow-y-auto rounded-[var(--radius-lg)] border border-border bg-bg p-3 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          {open && <ConvertForm onRunning={setRunning} onClose={close} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ConvertForm({
  onRunning,
  onClose,
}: {
  onRunning: (running: boolean) => void;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const [files, setFiles] = useState<DataFile[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<ExportFormat>("parquet");
  const [outDir, setOutDir] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<ConvertProgress | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ConvertOutcome | null>(null);
  const chosen = useRef(false);

  const choose = async () => {
    const dir = await pickFolder().catch(() => null);
    if (!dir) return;
    setFolder(dir);
    setOutcome(null);
    setError(undefined);
    try {
      const list = await listDataFiles(dir);
      setFiles(list);
      setPicked(new Set(list.map((f) => f.path)));
      // Parquet files probably go the other way.
      if (list.length > 0 && list.every((f) => f.format === "parquet")) setFormat("csv");
    } catch (e) {
      setFiles(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Ask for the folder straight away.
  useEffect(() => {
    if (chosen.current) return;
    chosen.current = true;
    void choose();
  }, []);

  const selected = useMemo(() => (files ?? []).filter((f) => picked.has(f.path)), [files, picked]);
  const bytes = selected.reduce((n, f) => n + f.sizeBytes, 0);
  const target = outDir ?? folder;
  const allPicked = files !== null && files.length > 0 && selected.length === files.length;

  const run = async () => {
    if (!target || selected.length === 0) return;
    const id = `convert-${nextJob++}`;
    setJob(id);
    setError(undefined);
    setOutcome(null);
    onRunning(true);
    const unlisten = await onConvertProgress((p) => p.jobId === id && setProgress(p)).catch(
      () => () => {},
    );
    try {
      setOutcome(
        await convertFiles(
          { files: selected.map((f) => f.path), format, outDir: target, overwrite },
          id,
        ),
      );
    } catch (e) {
      setError(
        (e as { kind?: string }).kind === "cancelled"
          ? "Cancelled. Files already converted were kept."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      unlisten();
      setJob(null);
      setProgress(null);
      onRunning(false);
    }
  };

  const converted = outcome?.files.filter((f) => f.output) ?? [];
  const failed = outcome?.files.filter((f) => !f.output) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-fg">Convert files</h2>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-fg" title={folder ?? undefined}>
          {folder ?? "No folder chosen"}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void choose()} disabled={!!job}>
          <FolderOpen className="size-3.5" aria-hidden /> Choose folder…
        </Button>
      </div>
      {files && files.length === 0 && (
        <p className="text-fg-muted">
          This folder has no CSV, TSV, JSON or Parquet files (subfolders aren’t searched).
        </p>
      )}
      {files && files.length > 0 && (
        <fieldset className="flex flex-col gap-1" disabled={!!job}>
          <legend className={`mb-1 ${labelClass}`}>
            {plural(selected.length, "file")} of {files.length}, {formatBytes(bytes)}
          </legend>
          <label className="flex items-center gap-1.5 text-fg">
            <input
              type="checkbox"
              checked={allPicked}
              aria-label="All files"
              onChange={() => setPicked(allPicked ? new Set() : new Set(files.map((f) => f.path)))}
            />
            All files
          </label>
          <ul aria-label="Files to convert" className="flex max-h-48 flex-col overflow-y-auto">
            {files.map((f) => (
              <li key={f.path}>
                <label className="flex min-w-0 items-center gap-1.5 text-fg" title={f.path}>
                  <input
                    type="checkbox"
                    checked={picked.has(f.path)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(f.path);
                      else next.delete(f.path);
                      setPicked(next);
                    }}
                  />
                  <span className="truncate">{baseName(f.path)}</span>
                  <span className="ml-auto shrink-0 text-fg-subtle">
                    → {convertedName(f.path, format)} · {formatBytes(f.sizeBytes)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {files && files.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Convert to</span>
            <select
              className={fieldClass}
              value={format}
              disabled={!!job}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {CONVERT_FORMATS.map((f) => (
                <option key={f.format} value={f.format}>
                  {f.label} — {f.hint}
                </option>
              ))}
            </select>
          </label>
          <div className="flex min-w-0 flex-col gap-1">
            <span className={labelClass}>Save to</span>
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-fg" title={target ?? undefined}>
                {outDir ? baseName(outDir) : "The same folder"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!job}
                onClick={() =>
                  void pickFolder()
                    .catch(() => null)
                    .then((d) => d && setOutDir(d))
                }
              >
                Change…
              </Button>
            </div>
          </div>
          <label className="col-span-2 flex items-center gap-1.5 text-fg">
            <input
              type="checkbox"
              checked={overwrite}
              disabled={!!job}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            Replace files that already exist (otherwise they are skipped)
          </label>
        </div>
      )}
      {job && (
        <div role="status" className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-fg">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            {progress?.file
              ? `Converting ${progress.file} (${progress.done + 1} of ${progress.total})…`
              : "Starting…"}
          </span>
          <progress
            aria-label="Conversion progress"
            className="h-1.5 w-full accent-[var(--accent)]"
            max={100}
            value={progress?.percent ?? 0}
          />
        </div>
      )}
      {outcome && (
        <div role="status" className="flex flex-col gap-1">
          <span className="flex items-start gap-1.5 text-fg">
            <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            Converted {plural(converted.length, "file")}
            {converted.length > 0 &&
              `: ${formatBytes(converted.reduce((n, f) => n + f.sourceBytes, 0))} → ${formatBytes(
                converted.reduce((n, f) => n + f.outputBytes, 0),
              )}`}{" "}
            in {formatDuration(outcome.elapsedMs)}.
          </span>
          {failed.length > 0 && (
            <ul aria-label="Files not converted" className="flex flex-col gap-0.5">
              {failed.map((f) => (
                <li key={f.source} className="flex items-start gap-1.5 text-fg-muted">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 break-words">
                    {baseName(f.source)}: {f.error}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="flex gap-1.5 text-fg-muted">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      <div className="flex justify-end gap-2">
        {job ? (
          <Button size="sm" variant="ghost" onClick={() => void cancelExport(job)}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={onClose}>
            {outcome ? "Close" : "Cancel"}
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={!!job || !target || selected.length === 0}
          onClick={() => void run()}
        >
          Convert {plural(selected.length, "file")}
        </Button>
      </div>
    </div>
  );
}
