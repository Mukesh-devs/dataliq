import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState, type ReactNode } from "react";

/** What the buttons need from the window (the app's window by default). */
export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

const button =
  "flex h-full w-[46px] shrink-0 items-center justify-center text-fg transition-colors duration-[var(--duration)]";

/** 10 px glyphs drawn like the system's (thin lines, square ends). */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/**
 * Minimise, maximise (or restore) and close, at the end of DataLiq's own
 * title bar. They look and act like the system's: grey on hover, red for
 * close. Not in the Tab order, as the system's aren't: from the keyboard,
 * Alt+F4 and Win+arrows still work.
 */
export function WindowControls({ api }: { api?: WindowApi }) {
  const win = useMemo<WindowApi>(() => api ?? getCurrentWindow(), [api]);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    const sync = () =>
      void win.isMaximized().then(
        (m) => !gone && setMaximized(m),
        () => {},
      );
    sync();
    void win.onResized(sync).then(
      (unlisten) => (gone ? unlisten() : (off = unlisten)),
      () => {},
    );
    return () => {
      gone = true;
      off?.();
    };
  }, [win]);

  return (
    <div className="flex h-full shrink-0 self-stretch" role="group" aria-label="Window">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Minimize"
        title="Minimize"
        className={`${button} hover:bg-hover active:bg-active`}
        onClick={() => void win.minimize()}
      >
        <Glyph>
          <path d="M0 5.5h10" />
        </Glyph>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        className={`${button} hover:bg-hover active:bg-active`}
        onClick={() => void win.toggleMaximize()}
      >
        <Glyph>
          {maximized ? (
            <>
              <path d="M2.5 2.5V.5h7v7h-2" />
              <rect x=".5" y="2.5" width="7" height="7" />
            </>
          ) : (
            <rect x=".5" y=".5" width="9" height="9" />
          )}
        </Glyph>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        title="Close"
        className={`${button} hover:bg-[#c42b1c] hover:text-white active:bg-[#b22a1b] active:text-white`}
        onClick={() => void win.close()}
      >
        <Glyph>
          <path d="M.5.5l9 9M9.5.5l-9 9" />
        </Glyph>
      </button>
    </div>
  );
}
