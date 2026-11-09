import { CircleAlert, X } from "lucide-react";
import { useSession } from "../../stores/session";
import { Button, IconButton } from "../ui/Button";

/**
 * After DataLiq closed unexpectedly: says so, that the tabs came back, and
 * offers the diagnostics for a bug report (copied, never sent).
 */
export function CrashNotice() {
  const crashed = useSession((s) => s.crashed);
  const dismiss = useSession((s) => s.dismissCrash);
  const copy = useSession((s) => s.copyDiagnostics);
  if (!crashed) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[12px] text-fg-muted"
    >
      <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1">
        DataLiq closed unexpectedly last time. Your open files, filters and layouts were kept. The
        details are in a local crash log.
      </span>
      <Button size="sm" variant="ghost" onClick={() => void copy()}>
        Copy diagnostics
      </Button>
      <IconButton label="Dismiss" className="size-5" onClick={dismiss}>
        <X className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}
