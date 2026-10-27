import { useSyncExternalStore } from "react";
import { resolveTheme, useSettings, type ResolvedTheme } from "../stores/settings";

const query = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(query);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** The theme actually in use: the setting, or the OS scheme for "system". */
export function useResolvedTheme(): ResolvedTheme {
  const theme = useSettings((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribe, systemPrefersDark);
  return resolveTheme(theme, systemDark);
}
