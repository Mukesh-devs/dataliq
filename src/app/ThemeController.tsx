import { useEffect } from "react";
import { useSettings } from "../stores/settings";
import { useResolvedTheme } from "./useResolvedTheme";

/** Applies the resolved theme and density as attributes on <html>. Renders nothing. */
export function ThemeController() {
  const resolved = useResolvedTheme();
  const density = useSettings((s) => s.density);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.density = density;
  }, [resolved, density]);

  return null;
}
