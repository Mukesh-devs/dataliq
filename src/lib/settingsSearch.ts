import type { SettingsSection } from "../stores/app";

/** The parts of Settings, in order, as listed on the left. */
export const SECTIONS: { id: SettingsSection; title: string }[] = [
  { id: "appearance", title: "Appearance" },
  { id: "memory", title: "Memory and speed" },
  { id: "cache", title: "Cache" },
  { id: "export", title: "Export" },
  { id: "assistants", title: "AI assistants" },
  { id: "updates", title: "Updates" },
  { id: "file-types", title: "File types" },
];

/** Every word of `query` appears in `text` (any case). */
export function matchesQuery(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}
