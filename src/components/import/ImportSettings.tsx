import * as Popover from "@radix-ui/react-popover";
import { SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CsvOptions, SniffedCsv } from "../../lib/files";
import { Button } from "../ui/Button";

interface ImportSettingsProps {
  options: CsvOptions;
  sniffed: SniffedCsv | null;
  onApply: (options: CsvOptions) => void;
}

const DELIMITERS: { label: string; value: string }[] = [
  { label: "Comma ,", value: "," },
  { label: "Semicolon ;", value: ";" },
  { label: "Tab", value: "\t" },
  { label: "Pipe |", value: "|" },
];

function describeChar(c: string | undefined): string {
  if (c === undefined) return "";
  if (c === "\t") return "Tab";
  // DuckDB's sniffer reports "no quote/escape character" as "(empty)".
  if (c === "" || c === "(empty)") return "none";
  return c;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
      <span className="text-fg-muted">{label}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        {children}
        {hint && <span className="text-[11px] text-fg-subtle">{hint}</span>}
      </span>
    </label>
  );
}

const inputClass =
  "h-7 w-full rounded-[var(--radius)] border border-border bg-bg px-2 text-fg outline-none focus:border-accent";

/** Popover showing detected CSV settings and letting the user override them. */
export function ImportSettings({ options, sniffed, onApply }: ImportSettingsProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CsvOptions>(options);
  const update = (changes: Partial<CsvOptions>) => setDraft((d) => ({ ...d, ...changes }));
  const detected = (v: string | undefined | null) => (v ? `Detected: ${v}` : undefined);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft(options);
      }}
    >
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" aria-label="Import settings">
          <SlidersHorizontal className="size-3.5" aria-hidden /> Import settings
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-96 rounded-[var(--radius-lg)] border border-border bg-bg p-4 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              onApply(draft);
              setOpen(false);
            }}
          >
            <h2 className="font-semibold text-fg">Import settings</h2>
            <Field label="Delimiter" hint={detected(describeChar(sniffed?.delimiter))}>
              <select
                aria-label="Delimiter"
                className={inputClass}
                value={draft.delimiter ?? ""}
                onChange={(e) => update({ delimiter: e.target.value || undefined })}
              >
                <option value="">Auto-detect</option>
                {DELIMITERS.map((d) => (
                  <option key={d.label} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Header row"
              hint={sniffed ? `Detected: ${sniffed.hasHeader ? "yes" : "no"}` : undefined}
            >
              <select
                aria-label="Header row"
                className={inputClass}
                value={draft.header === undefined ? "" : String(draft.header)}
                onChange={(e) =>
                  update({ header: e.target.value === "" ? undefined : e.target.value === "true" })
                }
              >
                <option value="">Auto-detect</option>
                <option value="true">First row is the header</option>
                <option value="false">No header</option>
              </select>
            </Field>
            <Field label="Quote" hint={detected(describeChar(sniffed?.quote))}>
              <input
                aria-label="Quote"
                className={inputClass}
                maxLength={4}
                placeholder="Auto"
                value={draft.quote ?? ""}
                onChange={(e) => update({ quote: e.target.value || undefined })}
              />
            </Field>
            <Field label="Encoding">
              <select
                aria-label="Encoding"
                className={inputClass}
                value={draft.encoding ?? ""}
                onChange={(e) =>
                  update({ encoding: (e.target.value || undefined) as CsvOptions["encoding"] })
                }
              >
                <option value="">UTF-8 (default)</option>
                <option value="latin-1">Latin-1 (ISO-8859-1)</option>
                <option value="utf-16">UTF-16</option>
              </select>
            </Field>
            <Field label="Skip rows" hint={sniffed ? `Detected: ${sniffed.skipRows}` : undefined}>
              <input
                aria-label="Skip rows"
                className={inputClass}
                type="number"
                min={0}
                placeholder="Auto"
                value={draft.skipRows ?? ""}
                onChange={(e) =>
                  update({ skipRows: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Date format" hint={detected(sniffed?.dateFormat)}>
              <input
                aria-label="Date format"
                className={`${inputClass} font-mono`}
                placeholder="e.g. %d.%m.%Y"
                value={draft.dateFormat ?? ""}
                onChange={(e) => update({ dateFormat: e.target.value || undefined })}
              />
            </Field>
            <label className="flex items-center gap-2 text-fg">
              <input
                type="checkbox"
                checked={draft.ignoreErrors ?? false}
                onChange={(e) => update({ ignoreErrors: e.target.checked || undefined })}
              />
              Ignore bad rows
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setDraft({})}>
                Reset
              </Button>
              <Button size="sm" variant="primary" type="submit">
                Apply
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
