import { FolderOpen, Search, X } from "lucide-react";
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { EXPORT_FORMATS } from "../../lib/exporting";
import {
  FILE_EXTENSIONS,
  pickFolder,
  saveSettings,
  settingsInfo,
  type AppSettings,
  type SettingsInfo,
} from "../../lib/files";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { isMac } from "../../lib/platform";
import { matchesQuery, SECTIONS } from "../../lib/settingsSearch";
import { useApp, type SettingsSection } from "../../stores/app";
import { useExport, type ExportDefaults } from "../../stores/export";
import { useNotice } from "../../stores/notice";
import { useSettings, type Density, type ThemePreference } from "../../stores/settings";
import { Button } from "../ui/Button";
import { McpSettings } from "./McpSettings";

const inputClass =
  "h-7 min-w-0 rounded-[var(--radius)] border border-border bg-bg px-2 text-[13px] text-fg outline-none focus:border-accent disabled:opacity-50";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The search, and whether the current section's title matches it (then all of it shows). */
const Filter = createContext<{ query: string; sectionMatches: boolean }>({
  query: "",
  sectionMatches: true,
});

/** A setting that hides itself when it doesn't match the search. */
function useShown(text: string): boolean {
  const { query, sectionMatches } = useContext(Filter);
  return query.trim() === "" || sectionMatches || matchesQuery(text, query);
}

/** An error from saving a setting, shown under it. */
const Errors = createContext<Record<string, string>>({});

/** A labelled setting; the label is linked to the control by id. */
function Field({
  label,
  hint,
  terms = "",
  errorKey,
  children,
}: {
  label: string;
  hint?: ReactNode;
  /** More words that should find it (the hint's text when it's built). */
  terms?: string;
  errorKey?: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  const error = useContext(Errors)[errorKey ?? ""];
  const shown = useShown(`${label} ${typeof hint === "string" ? hint : ""} ${terms}`);
  if (!shown) return null;
  return (
    <div
      data-setting
      className="grid grid-cols-[13rem_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5"
    >
      <label htmlFor={id} className="pt-1 text-fg-muted">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-0.5">
        {cloneElement(children, { id })}
        {hint && <span className="text-[11px] text-fg-subtle">{hint}</span>}
        {error && (
          <span role="alert" className="text-[12px] text-danger">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/** A checkbox setting, lined up with the fields' controls. */
function Check({
  checked,
  onChange,
  children,
  terms = "",
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: string;
  terms?: string;
  disabled?: boolean;
}) {
  const shown = useShown(`${children} ${terms}`);
  if (!shown) return null;
  return (
    <label data-setting className="ml-[13.75rem] flex items-center gap-2 text-fg">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

/** Any other content of a section, found by `terms`. */
function Row({ terms, children }: { terms: string; children: ReactNode }) {
  const shown = useShown(terms);
  if (!shown) return null;
  return <div data-setting>{children}</div>;
}

function Section({
  id,
  title,
  children,
}: {
  id: SettingsSection;
  title: string;
  children: ReactNode;
}) {
  const { query } = useContext(Filter);
  const sectionMatches = query.trim() !== "" && matchesQuery(title, query);
  return (
    <Filter.Provider value={{ query, sectionMatches }}>
      <section
        data-section={id}
        aria-labelledby={`settings-${id}`}
        // Hidden when the search leaves none of its settings.
        className="flex scroll-mt-4 flex-col gap-2.5 [&:not(:has([data-setting]))]:hidden"
      >
        <h2
          id={`settings-${id}`}
          className="border-b border-border pb-1.5 text-[13px] font-semibold text-fg"
        >
          {title}
        </h2>
        {children}
      </section>
    </Filter.Provider>
  );
}

/**
 * A typed value, saved when it's done: on Enter or on leaving the box.
 * Escape puts back the saved value.
 */
function Typed({
  value,
  onCommit,
  className,
  id,
  ...props
}: {
  value: string;
  onCommit: (text: string) => void;
  className?: string;
  id?: string;
  placeholder?: string;
  type?: "text" | "number";
  min?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  // Follows the saved value unless it's being typed over.
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);
  const commit = () => {
    editing.current = false;
    if (text !== value) onCommit(text);
  };
  return (
    <input
      id={id}
      className={className}
      value={text}
      onChange={(e) => {
        editing.current = true;
        setText(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && editing.current) {
          e.preventDefault();
          editing.current = false;
          setText(value);
        }
      }}
      {...props}
    />
  );
}

/** A number that is empty for "automatic". */
function Auto({
  value,
  onCommit,
  placeholder,
  min,
  id,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  placeholder: string;
  min: number;
  id?: string;
}) {
  return (
    <Typed
      id={id}
      type="number"
      min={min}
      className={`${inputClass} w-36`}
      placeholder={placeholder}
      value={value === null ? "" : String(value)}
      onCommit={(t) => onCommit(t.trim() === "" ? null : Number(t))}
    />
  );
}

/** A folder: typed, or picked; empty for the default. */
function Folder({
  value,
  onCommit,
  placeholder,
  id,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  placeholder: string;
  id?: string;
}) {
  return (
    <div className="flex gap-1">
      <Typed
        id={id}
        className={`${inputClass} flex-1 font-mono text-[12px]`}
        placeholder={placeholder}
        value={value ?? ""}
        onCommit={(t) => onCommit(t.trim() || null)}
      />
      <Button
        size="sm"
        variant="secondary"
        className="h-7"
        aria-label="Choose a folder"
        title="Choose a folder"
        onClick={() =>
          void pickFolder().then((dir) => {
            if (dir) onCommit(dir);
          })
        }
      >
        <FolderOpen className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

/** The Settings tab: every setting by section, searchable, applied as it changes. */
export function SettingsPage() {
  const app = useApp((s) => s.settings);
  const cache = useApp((s) => s.cache);
  const section = useApp((s) => s.settingsSection);
  const setSettings = useApp((s) => s.setSettings);
  const refreshCache = useApp((s) => s.refreshCache);
  const clearCache = useApp((s) => s.clearCache);
  const ui = useSettings();
  const exportDefaults = useExport((s) => s.defaults);
  const setExportDefaults = useExport((s) => s.setDefaults);
  const notice = useNotice((s) => s.show);
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<SettingsSection>(section ?? "appearance");
  const [visible, setVisible] = useState<SettingsSection[]>(SECTIONS.map((s) => s.id));
  const scroller = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void settingsInfo()
      .then(setInfo)
      .catch((e: unknown) => setErrors((x) => ({ ...x, info: messageOf(e) })));
    void refreshCache();
  }, [refreshCache]);

  // Opened for a part of it (e.g. from the memory warning): show that part.
  useEffect(() => {
    if (!section) {
      searchBox.current?.focus();
      return;
    }
    setCurrent(section);
    scroller.current
      ?.querySelector(`[data-section="${section}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [section]);

  // Which sections the search leaves, for the list on the left.
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    setVisible(
      SECTIONS.map((s) => s.id).filter(
        (id) => root.querySelector(`[data-section="${id}"] [data-setting]`) !== null,
      ),
    );
  }, [query, app, info]);

  /** Saves backend settings at once; an error shows under `key`. */
  const saveApp = async (changes: Partial<AppSettings>, key: string) => {
    const now = useApp.getState().settings;
    if (!now) return;
    try {
      const out = await saveSettings({ ...now, ...changes });
      setSettings(out.settings);
      setErrors((x) => {
        const rest = { ...x };
        delete rest[key];
        return rest;
      });
      // Only for the folders: the other settings apply at once.
      if (out.restartNeeded && ("cacheDir" in changes || "tempDir" in changes))
        notice("Saved. The new folder is used when DataLiq restarts.");
      void refreshCache();
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: messageOf(e) }));
    }
  };
  const setExport = (changes: Partial<ExportDefaults>) => setExportDefaults(changes);
  const gb = (mb: number) => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  const types = FILE_EXTENSIONS.filter((e) => !["gz", "zst", "txt", "tab"].includes(e))
    .map((e) => `.${e}`)
    .join(", ");

  const goTo = (id: SettingsSection) => {
    setCurrent(id);
    scroller.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: "start" });
  };
  // The section at the top of the page is the current one.
  const onScroll = () => {
    const root = scroller.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top + 24;
    let at: SettingsSection = visible[0] ?? "appearance";
    for (const id of visible) {
      const el = root.querySelector(`[data-section="${id}"]`);
      if (el && el.getBoundingClientRect().top <= top) at = id;
    }
    setCurrent(at);
  };

  return (
    <section aria-label="Settings" className="flex min-h-0 flex-1 bg-bg">
      <nav
        aria-label="Settings sections"
        className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-surface px-2 py-4"
      >
        <h1 className="mb-2 px-2 text-[15px] font-semibold text-fg">Settings</h1>
        {SECTIONS.filter((s) => visible.includes(s.id)).map((s) => (
          <button
            key={s.id}
            type="button"
            aria-current={current === s.id ? "true" : undefined}
            onClick={() => goTo(s.id)}
            className={cn(
              "flex h-7 items-center rounded-[var(--radius)] px-2 text-left",
              current === s.id
                ? "bg-active font-medium text-fg"
                : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            {s.title}
          </button>
        ))}
      </nav>
      <div ref={scroller} onScroll={onScroll} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-8 pt-5 pb-10">
          <div className="flex flex-col gap-1.5">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
                aria-hidden
              />
              <input
                ref={searchBox}
                type="search"
                aria-label="Search settings"
                placeholder="Search settings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query !== "") {
                    e.preventDefault();
                    setQuery("");
                  }
                }}
                className="h-9 w-full rounded-[var(--radius)] border border-border bg-bg pr-8 pl-8 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent [&::-webkit-search-cancel-button]:hidden"
              />
              {query !== "" && (
                <button
                  type="button"
                  aria-label="Clear the search"
                  onClick={() => setQuery("")}
                  className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-[var(--radius)] text-fg-subtle hover:bg-hover hover:text-fg"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
            <p className="text-[12px] text-fg-subtle">Changes apply as you make them.</p>
          </div>

          {!app ? (
            <p className="text-fg-muted">Settings aren&apos;t available.</p>
          ) : (
            <Errors.Provider value={errors}>
              <Filter.Provider value={{ query, sectionMatches: false }}>
                <Section id="appearance" title="Appearance">
                  <Field label="Theme" terms="dark light colours colors">
                    <select
                      className={`${inputClass} w-48`}
                      value={ui.theme}
                      onChange={(e) => ui.setTheme(e.target.value as ThemePreference)}
                    >
                      <option value="system">Follow system</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </Field>
                  <Field label="Density" hint="Compact fits more rows on screen.">
                    <select
                      className={`${inputClass} w-48`}
                      value={ui.density}
                      onChange={(e) => ui.setDensity(e.target.value as Density)}
                    >
                      <option value="comfortable">Comfortable</option>
                      <option value="compact">Compact</option>
                    </select>
                  </Field>
                  <Check checked={ui.headerCharts} onChange={ui.setHeaderCharts} terms="charts">
                    Small histograms under the column names
                  </Check>
                  <Check
                    checked={ui.restoreSession}
                    onChange={ui.setRestoreSession}
                    terms="session restore tabs"
                  >
                    Reopen the last session’s files at startup
                  </Check>
                </Section>

                <Section id="memory" title="Memory and speed">
                  <Field
                    label="Memory limit (MB)"
                    terms="ram spill"
                    errorKey="memoryLimitMb"
                    hint={
                      info &&
                      `Empty: automatic, half of this computer's ${gb(info.totalMemoryMb)} (${gb(info.defaultMemoryLimitMb)}). Bigger jobs spill to disk past it. Applies at once.`
                    }
                  >
                    <Auto
                      value={app.memoryLimitMb}
                      onCommit={(v) => void saveApp({ memoryLimitMb: v }, "memoryLimitMb")}
                      placeholder={info ? String(info.defaultMemoryLimitMb) : "Automatic"}
                      min={256}
                    />
                  </Field>
                  <Field
                    label="Worker threads"
                    terms="cores cpu"
                    errorKey="threads"
                    hint={info && `Empty: every core (${info.cores}). Applies at once.`}
                  >
                    <Auto
                      value={app.threads}
                      onCommit={(v) => void saveApp({ threads: v }, "threads")}
                      placeholder={info ? String(info.cores) : "Automatic"}
                      min={1}
                    />
                  </Field>
                  <Field
                    label="Temporary folder"
                    errorKey="tempDir"
                    hint="Where big sorts and joins spill. Used after a restart."
                  >
                    <Folder
                      value={app.tempDir}
                      onCommit={(v) => void saveApp({ tempDir: v }, "tempDir")}
                      placeholder={info?.defaultTempDir ?? "Default"}
                    />
                  </Field>
                  <Field
                    label="Quiet imports under (MB)"
                    errorKey="smallFileMb"
                    hint="Smaller files import without a progress bar."
                  >
                    <Typed
                      type="number"
                      min={0}
                      className={`${inputClass} w-36`}
                      value={String(app.smallFileMb)}
                      onCommit={(t) =>
                        void saveApp({ smallFileMb: Math.max(0, Number(t) || 0) }, "smallFileMb")
                      }
                    />
                  </Field>
                </Section>

                <Section id="cache" title="Cache">
                  <Check
                    checked={app.cacheEnabled}
                    onChange={(on) => void saveApp({ cacheEnabled: on }, "cacheEnabled")}
                  >
                    Keep imported files, so they reopen at once
                  </Check>
                  <Field
                    label="Size limit (GB)"
                    errorKey="cacheMaxGb"
                    terms="oldest"
                    hint={
                      cache &&
                      `In use: ${formatBytes(cache.usedBytes)} in ${cache.entries} files. The oldest go first.`
                    }
                  >
                    <Typed
                      type="number"
                      min={1}
                      className={`${inputClass} w-36`}
                      disabled={!app.cacheEnabled}
                      value={String(app.cacheMaxGb)}
                      onCommit={(t) =>
                        void saveApp({ cacheMaxGb: Math.max(1, Number(t) || 1) }, "cacheMaxGb")
                      }
                    />
                  </Field>
                  <Field
                    label="Location"
                    errorKey="cacheDir"
                    terms="folder"
                    hint="Used after a restart."
                  >
                    <Folder
                      value={app.cacheDir}
                      onCommit={(v) => void saveApp({ cacheDir: v }, "cacheDir")}
                      placeholder={info?.defaultCacheDir ?? "Default"}
                    />
                  </Field>
                  <Row terms="clear cache now empty">
                    <div className="ml-[13.75rem]">
                      <Button size="sm" variant="secondary" onClick={() => void clearCache()}>
                        Clear cache now
                      </Button>
                    </div>
                  </Row>
                </Section>

                <Section id="export" title="Export">
                  <Field label="Default format" terms="export csv parquet excel json">
                    <select
                      className={`${inputClass} w-48`}
                      value={exportDefaults.format}
                      onChange={(e) =>
                        setExport({ format: e.target.value as ExportDefaults["format"] })
                      }
                    >
                      {EXPORT_FORMATS.map((f) => (
                        <option key={f.format} value={f.format}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="CSV delimiter" terms="export separator comma semicolon tab pipe">
                    <select
                      className={`${inputClass} w-48`}
                      value={exportDefaults.delimiter}
                      onChange={(e) => setExport({ delimiter: e.target.value })}
                    >
                      <option value=",">Comma ,</option>
                      <option value=";">Semicolon ;</option>
                      <option value={"\t"}>Tab</option>
                      <option value="|">Pipe |</option>
                    </select>
                  </Field>
                  <Check
                    checked={exportDefaults.header}
                    onChange={(on) => setExport({ header: on })}
                    terms="export"
                  >
                    Header row with the column names
                  </Check>
                </Section>

                <Section id="assistants" title="AI assistants">
                  <Row terms="ai assistants mcp claude desktop code folders read data allow export">
                    <McpSettings
                      value={app}
                      onChange={(changes) => void saveApp(changes, "mcp")}
                      info={info}
                    />
                  </Row>
                </Section>

                <Section id="updates" title="Updates">
                  <Row terms="check updates new version startup">
                    <div className="flex flex-col gap-1">
                      <label className="flex items-center gap-2 text-fg">
                        <input
                          type="checkbox"
                          checked={ui.checkUpdates}
                          onChange={(e) => ui.setCheckUpdates(e.target.checked)}
                        />
                        Check for a new version when DataLiq starts (once a day at most)
                      </label>
                      <p className="text-[12px] text-fg-muted">
                        Only the version number is asked for; your files never leave this computer.
                        Help › Check for updates works either way.
                      </p>
                    </div>
                  </Row>
                </Section>

                <Section id="file-types" title="File types">
                  <Row terms={`file types open with default associations ${types}`}>
                    <p className="text-[12px] text-fg-muted">
                      The installer registers DataLiq for {types}.{" "}
                      {isMac
                        ? "To open them with DataLiq by default, use Get Info › Open with › Change All in the Finder."
                        : "To open them with DataLiq by default, choose Open with › DataLiq › Always in your file manager."}
                    </p>
                  </Row>
                </Section>
              </Filter.Provider>
            </Errors.Provider>
          )}

          {query.trim() !== "" && visible.length === 0 && (
            <p className="text-fg-muted">No settings match “{query.trim()}”.</p>
          )}
          {errors.mcp && (
            <p role="alert" className="text-[12px] text-danger">
              {errors.mcp}
            </p>
          )}
          {info && query.trim() === "" && (
            <p className="text-[11px] text-fg-subtle">
              Saved in <code className="font-mono">{info.settingsFile}</code>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
