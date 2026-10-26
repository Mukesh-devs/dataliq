import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Real backend responses recorded by src-tauri/tests/ui_recordings.rs. */
const recordings = JSON.parse(
  readFileSync(resolve(process.cwd(), "e2e/recordings/backend.json"), "utf8"),
) as {
  version: string;
  files: Record<string, { info: unknown; preview: string }>;
};

export interface MockOptions {
  /** Paths returned by successive "Open file" dialogs. */
  dialogPaths?: string[];
}

/**
 * Installs a fake `window.__TAURI_INTERNALS__` before the app loads, so the
 * frontend runs in a plain browser against recorded backend responses.
 * Every invoke is logged in `window.__invokes` for assertions.
 */
export async function mockTauri(page: Page, options: MockOptions = {}) {
  await page.addInitScript(
    ({ recordings, dialogPaths }) => {
      const toBuffer = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const log: { cmd: string; args: unknown }[] = [];
      const w = window as unknown as Record<string, unknown>;
      w.__invokes = log;
      let nextCallback = 1;
      w.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        transformCallback: (cb: unknown) => {
          const id = nextCallback++;
          w[`_${id}`] = cb;
          return id;
        },
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          log.push({ cmd, args });
          const file = recordings.files[String(args.path)];
          switch (cmd) {
            case "run_query":
              return toBuffer(recordings.version);
            case "plugin:dialog|open":
              return dialogPaths.shift() ?? null;
            case "open_file":
              if (!file) throw { kind: "query", message: `File not found: ${String(args.path)}` };
              return file.info;
            case "preview_file":
              if (!file) throw { kind: "query", message: `File not found: ${String(args.path)}` };
              return toBuffer(file.preview);
            default:
              throw { kind: "internal", message: `unmocked command ${cmd}` };
          }
        },
      };
    },
    { recordings, dialogPaths: options.dialogPaths ?? [] },
  );
}
