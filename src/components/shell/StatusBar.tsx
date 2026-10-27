import { ChartColumn, Monitor, Moon, Sun } from "lucide-react";
import { useNotice } from "../../stores/notice";
import { useSettings, type ThemePreference } from "../../stores/settings";
import { Button, IconButton } from "../ui/Button";

const themeIcon: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };
const themeLabel: Record<ThemePreference, string> = {
  system: "Theme: follow system",
  light: "Theme: light",
  dark: "Theme: dark",
};

interface StatusBarProps {
  message: string;
  /** A button after the message, e.g. "Cancel" while a query runs. */
  action?: { label: string; run: () => void };
}

export function StatusBar({ message, action }: StatusBarProps) {
  // A short-lived notice ("Copied 12 rows as CSV") replaces the message.
  const notice = useNotice((s) => s.text);
  const theme = useSettings((s) => s.theme);
  const cycleTheme = useSettings((s) => s.cycleTheme);
  const headerCharts = useSettings((s) => s.headerCharts);
  const setHeaderCharts = useSettings((s) => s.setHeaderCharts);
  const Icon = themeIcon[theme];
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[12px] text-fg-muted">
      <span role="status" className="tabular truncate">
        {notice ?? message}
      </span>
      {action && (
        <Button size="sm" variant="ghost" className="h-5 px-1.5" onClick={action.run}>
          {action.label}
        </Button>
      )}
      <span className="flex-1" />
      <IconButton
        label={headerCharts ? "Hide column histograms" : "Show column histograms"}
        aria-pressed={headerCharts}
        onClick={() => setHeaderCharts(!headerCharts)}
        className={headerCharts ? "size-5 text-fg" : "size-5"}
      >
        <ChartColumn className="size-3.5" aria-hidden />
      </IconButton>
      <IconButton label={themeLabel[theme]} onClick={cycleTheme} className="size-5">
        <Icon className="size-3.5" aria-hidden />
      </IconButton>
    </footer>
  );
}
