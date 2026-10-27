import { useEffect } from "react";
import { create } from "zustand";

/** One action for the command palette. */
export interface Command {
  id: string;
  title: string;
  /** Section shown in the palette, e.g. "File", "View", "Copy". */
  group: string;
  /** Shortcut to show next to it, e.g. "Ctrl+O". */
  shortcut?: string;
  /** Extra words that should find it. */
  keywords?: string;
  run: () => void;
}

interface CommandsState {
  /** Commands by the part of the app that provides them. */
  sources: Record<string, Command[]>;
  set: (source: string, commands: Command[] | null) => void;
}

export const useCommands = create<CommandsState>()((set) => ({
  sources: {},
  set: (source, commands) =>
    set((s) => {
      const sources = { ...s.sources };
      if (commands) sources[source] = commands;
      else delete sources[source];
      return { sources };
    }),
}));

/** Every registered command, in registration order. */
export function allCommands(sources: Record<string, Command[]>): Command[] {
  return Object.values(sources).flat();
}

/** Registers `commands` for the palette while the calling component is mounted. */
export function useRegisterCommands(source: string, commands: Command[]) {
  const set = useCommands((s) => s.set);
  useEffect(() => {
    set(source, commands);
  }, [set, source, commands]);
  useEffect(() => () => set(source, null), [set, source]);
}

/**
 * Commands matching `query`: every word must appear in the title, group or
 * keywords (any case). Titles starting with the query come first.
 */
export function matchCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  const q = query.trim().toLowerCase();
  const hits = commands.filter((c) => {
    const hay = `${c.title} ${c.group} ${c.keywords ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const starts = (c: Command) => (c.title.toLowerCase().startsWith(q) ? 0 : 1);
  return hits
    .map((c, i) => ({ c, i }))
    .sort((a, b) => starts(a.c) - starts(b.c) || a.i - b.i)
    .map(({ c }) => c);
}
