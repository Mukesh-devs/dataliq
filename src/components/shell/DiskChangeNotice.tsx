import { FileWarning } from "lucide-react";
import type { Tab } from "../../stores/tabs";
import { Button } from "../ui/Button";

/**
 * The tab's file changed on disk (or is gone) since it was read: offer to
 * read it again, keeping the filters, sort and columns, or to carry on.
 */
export function DiskChangeNotice({
  tab,
  onReload,
  onIgnore,
}: {
  tab: Tab;
  onReload?: () => void;
  onIgnore: () => void;
}) {
  const change = tab.onDisk;
  if (!change) return null;
  const missing = change.status === "missing";
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[12px] text-fg-muted"
    >
      <FileWarning className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1">
        {missing
          ? "This file was moved or deleted since it was opened. What is on screen is what was read."
          : "This file changed on disk since it was opened."}
      </span>
      {!missing && onReload && (
        <Button
          size="sm"
          variant="primary"
          onClick={onReload}
          title="Read the file again, keeping the filters, sort and columns"
        >
          Reload
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onIgnore}>
        {missing ? "Dismiss" : "Keep as is"}
      </Button>
    </div>
  );
}
