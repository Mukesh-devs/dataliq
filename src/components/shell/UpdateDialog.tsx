import * as Popover from "@radix-ui/react-popover";
import { formatBytes } from "../../lib/format";
import { useUpdate } from "../../stores/update";
import { Button } from "../ui/Button";

/** Help › Check for updates, and a newer version found at startup. */
export function UpdateDialog() {
  const { phase, info, currentVersion, progress, error, open, setOpen, check, install } =
    useUpdate();
  const installing = phase === "installing";
  const percent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;
  return (
    <Popover.Root open={open} onOpenChange={(o) => !installing && setOpen(o)}>
      <Popover.Anchor className="absolute top-2 left-1/2" />
      <Popover.Portal>
        <Popover.Content
          aria-label="Updates"
          sideOffset={4}
          className="z-50 flex w-[min(28rem,calc(100vw-32px))] flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-bg p-4 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
        >
          <h2 className="font-semibold text-fg">
            {phase === "available" || installing
              ? `BigView ${info?.version} is available`
              : "Updates"}
          </h2>
          <div aria-live="polite" className="flex flex-col gap-2 text-fg-muted">
            {phase === "checking" && <p>Checking for updates…</p>}
            {phase === "latest" && <p>BigView {currentVersion} is the latest version.</p>}
            {phase === "unavailable" && (
              <p>
                This build of BigView can&apos;t update itself (it was built without an update key).
                Download new versions from the releases page.
              </p>
            )}
            {phase === "available" && info && (
              <>
                <p>
                  You have {info.currentVersion}.
                  {info.date && ` Released ${info.date.slice(0, 10)}.`} The download is checked
                  against BigView&apos;s signing key before it&apos;s installed.
                </p>
                {info.notes && (
                  <div
                    aria-label="Release notes"
                    className="max-h-48 overflow-y-auto rounded-[var(--radius)] border border-border bg-surface p-2 text-[12px] whitespace-pre-wrap text-fg"
                  >
                    {info.notes}
                  </div>
                )}
              </>
            )}
            {installing && (
              <>
                <p>
                  {progress
                    ? `Downloading… ${formatBytes(progress.downloaded)}${
                        progress.total ? ` of ${formatBytes(progress.total)}` : ""
                      }`
                    : "Starting the download…"}{" "}
                  BigView restarts when it&apos;s installed.
                </p>
                <div
                  role="progressbar"
                  aria-label="Download"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                  className="h-1.5 overflow-hidden rounded-full bg-surface"
                >
                  <div
                    className="h-full bg-accent transition-[width]"
                    style={{ width: `${percent ?? 0}%` }}
                  />
                </div>
              </>
            )}
            {phase === "error" && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            {phase === "available" ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Later
                </Button>
                <Button size="sm" variant="primary" onClick={() => void install()}>
                  Install and restart
                </Button>
              </>
            ) : phase === "error" ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void check()}>
                  Try again
                </Button>
              </>
            ) : (
              !installing && (
                <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              )
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
