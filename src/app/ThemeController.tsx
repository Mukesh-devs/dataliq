import { useEffect, useSyncExternalStore } from "react";
import { resolveTheme, useSettings } from "../stores/settings";

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

/** Applies the resolved theme and density as attributes on <html>. Renders nothing. */
export function ThemeController() {
  const theme = useSettings((s) => s.theme);
  const density = useSettings((s) => s.density);
  const systemDark = useSyncExternalStore(subscribe, systemPrefersDark);
  const resolved = resolveTheme(theme, systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.density = density;
  }, [resolved, density]);

  return null;
}
