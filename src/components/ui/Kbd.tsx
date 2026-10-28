import { formatShortcut } from "../../lib/platform";
import { cn } from "../../lib/cn";

interface KbdProps {
  shortcut: string;
  /** `onAccent` for use inside primary (accent-coloured) buttons. */
  tone?: "default" | "onAccent";
  className?: string;
}

/** Displays a keyboard shortcut such as "Mod+K" using platform symbols. */
export function Kbd({ shortcut, tone = "default", className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "rounded-[var(--radius-sm)] border px-1.5 py-px font-sans text-[11px]",
        tone === "onAccent"
          ? // An outline: the text sits on the accent itself (readable in both themes).
            "border-current/50 bg-transparent text-accent-fg"
          : "border-border bg-surface text-fg-subtle",
        className,
      )}
    >
      {formatShortcut(shortcut)}
    </kbd>
  );
}
