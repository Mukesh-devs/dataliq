import * as Popover from "@radix-ui/react-popover";
import { FolderOpen } from "lucide-react";
import { cloneElement, useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import { EXPORT_FORMATS } from "../../lib/exporting";
import {
  FILE_EXTENSIONS,
  pickFolder,
  saveSettings,
  settingsInfo,
  type AppSettings,
  type SettingsInfo,
} from "../../lib/files";
import { formatBytes } from "../../lib/format";
import { isMac } from "../../lib/platform";
import { useApp } from "../../stores/app";
import { useExport, type ExportDefaults } from "../../stores/export";
import { useNotice } from "../../stores/notice";
import { useSettings, type Density, type ThemePreference } from "../../stores/settings";
import { Button } from "../ui/Button";

const inputClass =
  "h-7 min-w-0 rounded-[var(--radius)] border border-border bg-bg px-2 text-[13px] text-fg outline-none focus:border-accent disabled:opacity-50";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A labelled row; the label is linked to the control by id. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[11rem_1fr] items-start gap-x-3 gap-y-0.5">
      <label htmlFor={id} className="pt-1 text-fg-muted">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-0.5">
        {cloneElement(children, { id })}
        {hint && <span className="text-[11px] text-fg-subtle">{hint}</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-[12px] font-semibold tracking-wide text-fg-subtle uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** A number box that is empty for "automatic". */
function Auto({
  value,
  onChange,
  placeholder,
  min,
  id,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder: string;
  min: number;
  id?: string;
}) {
  return (
    <input
      id={id}
      type="number"
      min={min}
      className={`${inputClass} w-36`}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

/** A folder: typed, or picked; empty for the default. */
function Folder({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder: string;
  id?: string;
}) {
  return (
    <div className="flex gap-1">
      <input
        id={id}
        className={`${inputClass} flex-1 font-mono text-[12px]`}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value.trim() || null)}
      />
      <Button
        size="sm"
        variant="secondary"
        className="h-7"
        aria-label="Choose a folder"
        title="Choose a folder"
        onClick={() =>
          void pickFolder().then((dir) => {
            if (dir) onChange(dir);
          })
        }
      >
        <FolderOpen className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

interface Draft {
  app: AppSettings;
  theme: ThemePreference;
  density: Density;
  headerCharts: boolean;
  exportDefaults: ExportDefaults;
}

function SettingsForm({ onDone }: { onDone: () => void }) {
  const app = useApp((s) => s.settings);
  const cache = useApp((s) => s.cache);
  const setSettings = useApp((s) => s.setSettings);
  const refreshCache = useApp((s) => s.refreshCache);
  const clearCache = useApp((s) => s.clearCache);
  const ui = useSettings();
  const exportDefaults = useExport((s) => s.defaults);
  const setExportDefaults = useExport((s) => s.setDefaults);
  const notice = useNotice((s) => s.show);
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(() =>
    app
      ? {
          app,
          theme: ui.theme,
          density: ui.density,
          headerCharts: ui.headerCharts,
          exportDefaults,
        }
      : null,
  );
  useEffect(() => {
    void settingsInfo()
      .then(setInfo)
      .catch((e: unknown) => setError(messageOf(e)));
    void refreshCache();
  }, [refreshCache]);

  if (!draft) return <p className="text-fg-muted">Settings aren't available.</p>;
  const setApp = (changes: Partial<AppSettings>) =>
    setDraft({ ...draft, app: { ...draft.app, ...changes } });
  const setExport = (changes: Partial<ExportDefaults>) =>
    setDraft({ ...draft, exportDefaults: { ...draft.exportDefaults, ...changes } });
  const gb = (mb: number) => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const out = await saveSettings(draft.app);
      setSettings(out.settings);
      ui.setTheme(draft.theme);
      ui.setDensity(draft.density);
      ui.setHeaderCharts(draft.headerCharts);
      setExportDefaults(draft.exportDefaults);
      void refreshCache();
      notice(
        out.restartNeeded
          ? "Settings saved. The new folders are used when BigView restarts."
          : "Settings saved.",
      );
      onDone();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  const types = FILE_EXTENSIONS.filter((e) => !["gz", "zst", "txt", "tab"].includes(e))
    .map((e) => `.${e}`)
    .join(", ");

  return (
    <form
      // The backend checks the values and says what's wrong in words.
      noValidate
      className="flex max-h-[calc(100vh-96px)] flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="pb-3 font-semibold text-fg">Settings</h2>
      <div className="-mr-2 flex min-h-0 flex-col gap-5 overflow-y-auto pr-2 pb-1">
        <Section title="Appearance">
          <Field label="Theme">
            <select
              className={`${inputClass} w-48`}
              value={draft.theme}
              onChange={(e) => setDraft({ ...draft, theme: e.target.value as ThemePreference })}
            >
              <option value="system">Follow system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Field>
          <Field label="Density" hint="Compact fits more rows on screen.">
            <select
              className={`${inputClass} w-48`}
              value={draft.density}
              onChange={(e) => setDraft({ ...draft, density: e.target.value as Density })}
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </Field>
          <label className="ml-[14rem] flex items-center gap-2 text-fg">
            <input
              type="checkbox"
              checked={draft.headerCharts}
              onChange={(e) => setDraft({ ...draft, headerCharts: e.target.checked })}
            />
            Small histograms under the column names
          </label>
        </Section>

        <Section title="Memory and speed">
          <Field
            label="Memory limit (MB)"
            hint={
              info &&
              `Empty: automatic, half of this computer's ${gb(info.totalMemoryMb)} (${gb(info.defaultMemoryLimitMb)}). Bigger jobs spill to disk past it. Applies at once.`
            }
          >
            <Auto
              value={draft.app.memoryLimitMb}
              onChange={(v) => setApp({ memoryLimitMb: v })}
              placeholder={info ? String(info.defaultMemoryLimitMb) : "Automatic"}
              min={256}
            />
          </Field>
          <Field
            label="Worker threads"
            hint={info && `Empty: every core (${info.cores}). Applies at once.`}
          >
            <Auto
              value={draft.app.threads}
              onChange={(v) => setApp({ threads: v })}
              placeholder={info ? String(info.cores) : "Automatic"}
              min={1}
            />
          </Field>
          <Field
            label="Temporary folder"
            hint="Where big sorts and joins spill. Used after a restart."
          >
            <Folder
              value={draft.app.tempDir}
              onChange={(v) => setApp({ tempDir: v })}
              placeholder={info?.defaultTempDir ?? "Default"}
            />
          </Field>
          <Field
            label="Quiet imports under (MB)"
            hint="Smaller files import without a progress bar."
          >
            <input
              type="number"
              min={0}
              className={`${inputClass} w-36`}
              value={draft.app.smallFileMb}
              onChange={(e) => setApp({ smallFileMb: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
        </Section>

        <Section title="Cache">
          <label className="ml-[14rem] flex items-center gap-2 text-fg">
            <input
              type="checkbox"
              checked={draft.app.cacheEnabled}
              onChange={(e) => setApp({ cacheEnabled: e.target.checked })}
            />
            Keep imported files, so they reopen at once
          </label>
          <Field
            label="Size limit (GB)"
            hint={
              cache &&
              `In use: ${formatBytes(cache.usedBytes)} in ${cache.entries} files. The oldest go first.`
            }
          >
            <input
              type="number"
              min={1}
              className={`${inputClass} w-36`}
              disabled={!draft.app.cacheEnabled}
              value={draft.app.cacheMaxGb}
              onChange={(e) => setApp({ cacheMaxGb: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Field>
          <Field label="Location" hint="Used after a restart.">
            <Folder
              value={draft.app.cacheDir}
              onChange={(v) => setApp({ cacheDir: v })}
              placeholder={info?.defaultCacheDir ?? "Default"}
            />
          </Field>
          <div className="ml-[14rem]">
            <Button size="sm" variant="secondary" onClick={() => void clearCache()}>
              Clear cache now
            </Button>
          </div>
        </Section>

        <Section title="Export">
          <Field label="Default format">
            <select
              className={`${inputClass} w-48`}
              value={draft.exportDefaults.format}
              onChange={(e) => setExport({ format: e.target.value as ExportDefaults["format"] })}
            >
              {EXPORT_FORMATS.map((f) => (
                <option key={f.format} value={f.format}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="CSV delimiter">
            <select
              className={`${inputClass} w-48`}
              value={draft.exportDefaults.delimiter}
              onChange={(e) => setExport({ delimiter: e.target.value })}
            >
              <option value=",">Comma ,</option>
              <option value=";">Semicolon ;</option>
              <option value={"\t"}>Tab</option>
              <option value="|">Pipe |</option>
            </select>
          </Field>
          <label className="ml-[14rem] flex items-center gap-2 text-fg">
            <input
              type="checkbox"
              checked={draft.exportDefaults.header}
              onChange={(e) => setExport({ header: e.target.checked })}
            />
            Header row with the column names
          </label>
        </Section>

        <Section title="File types">
          <p className="text-[12px] text-fg-muted">
            The installer registers BigView for {types}.{" "}
            {isMac
              ? "To open them with BigView by default, use Get Info › Open with › Change All in the Finder."
              : "To open them with BigView by default, choose Open with › BigView › Always in your file manager."}
          </p>
        </Section>

        {info && (
          <p className="text-[11px] text-fg-subtle">
            Saved in <code className="font-mono">{info.settingsFile}</code>
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 pt-3">
        {error && (
          <p role="alert" className="mr-auto text-[12px] text-danger">
            {error}
          </p>
        )}
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Settings (Ctrl+, / the menu / the palette). */
export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen);
  const setOpen = useApp((s) => s.setSettingsOpen);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Settings"
          sideOffset={4}
          className="z-50 w-[min(40rem,calc(100vw-32px))] rounded-[var(--radius-lg)] border border-border bg-bg p-4 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          {open && <SettingsForm onDone={() => setOpen(false)} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
