import { Monitor, Moon, Sun } from "lucide-react";
import { useSettings, type ThemePreference } from "../../stores/settings";
import { IconButton } from "../ui/Button";

const themeIcon: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };
const themeLabel: Record<ThemePreference, string> = {
  system: "Theme: follow system",
  light: "Theme: light",
  dark: "Theme: dark",
};

export function StatusBar({ message }: { message: string }) {
  const theme = useSettings((s) => s.theme);
  const cycleTheme = useSettings((s) => s.cycleTheme);
  const Icon = themeIcon[theme];
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[12px] text-fg-muted">
      <span role="status" className="tabular flex-1 truncate">
        {message}
      </span>
      <IconButton label={themeLabel[theme]} onClick={cycleTheme} className="size-5">
        <Icon className="size-3.5" aria-hidden />
      </IconButton>
    </footer>
  );
}
