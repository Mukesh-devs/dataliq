import { formatBytes } from "../../lib/format";
import { useUpdate } from "../../stores/update";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

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
    <Modal
      open={open}
      onOpenChange={(o) => !installing && setOpen(o)}
      title={
        phase === "available" || installing ? `DataLiq ${info?.version} is available` : "Updates"
      }
      label="Updates"
      width="w-[28rem]"
      dismissable={!installing}
      className="flex flex-col gap-3"
    >
      <div aria-live="polite" className="flex flex-col gap-2 text-fg-muted">
        {phase === "checking" && <p>Checking for updates…</p>}
        {phase === "latest" && <p>DataLiq {currentVersion} is the latest version.</p>}
        {phase === "unavailable" && (
          <p>
            This build of DataLiq can&apos;t update itself (it was built without an update key).
            Download new versions from the releases page.
          </p>
        )}
        {phase === "available" && info && (
          <>
            <p>
              You have {info.currentVersion}.{info.date && ` Released ${info.date.slice(0, 10)}.`}{" "}
              The download is checked against DataLiq&apos;s signing key before it&apos;s installed.
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
              DataLiq restarts when it&apos;s installed.
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
    </Modal>
  );
}
