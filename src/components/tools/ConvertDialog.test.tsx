import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useConvert } from "../../stores/convert";
import { ConvertDialog } from "./ConvertDialog";

type Args = Record<string, unknown>;

function backend() {
  const calls: { cmd: string; args: Args }[] = [];
  mockIPC((cmd, a) => {
    const args = (a ?? {}) as Args;
    calls.push({ cmd, args });
    if (cmd === "plugin:dialog|open") return "/data/calls";
    if (cmd === "plugin:event|listen") return 1;
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "list_data_files")
      return [
        { path: "/data/calls/jan.csv.gz", sizeBytes: 3_000_000, format: "csv" },
        { path: "/data/calls/feb.csv.gz", sizeBytes: 2_000_000, format: "csv" },
        { path: "/data/calls/mar.ndjson", sizeBytes: 1_000_000, format: "ndjson" },
      ];
    if (cmd === "convert_files")
      return {
        elapsedMs: 1500,
        files: [
          {
            source: "/data/calls/jan.csv.gz",
            output: "/data/calls/jan.parquet",
            rows: 10,
            sourceBytes: 3_000_000,
            outputBytes: 1_000_000,
            error: null,
          },
          {
            source: "/data/calls/feb.csv.gz",
            output: null,
            rows: 0,
            sourceBytes: 2_000_000,
            outputBytes: 0,
            error: "feb.parquet already exists.",
          },
        ],
      };
    throw new Error(`unexpected ${cmd}`);
  });
  return calls;
}

describe("ConvertDialog", () => {
  afterEach(() => {
    clearMocks();
    act(() => useConvert.getState().close());
  });

  it("lists a folder's data files and converts the picked ones", async () => {
    const calls = backend();
    render(<ConvertDialog />);
    act(() => useConvert.getState().show());
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: "Files to convert" });
    expect(list).toHaveTextContent("jan.csv.gz→ jan.parquet");
    expect(screen.getByText(/3 files of 3, 5\.7 MB/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /mar\.ndjson/ }));
    expect(screen.getByLabelText("All files")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Convert 2 files" }));
    await screen.findByText(/Converted 1 file: 2\.9 MB → 976\.6 KB/);
    expect(screen.getByRole("list", { name: "Files not converted" })).toHaveTextContent(
      "feb.csv.gz: feb.parquet already exists.",
    );
    const convert = calls.find((c) => c.cmd === "convert_files")!.args;
    expect(convert.request).toEqual({
      files: ["/data/calls/jan.csv.gz", "/data/calls/feb.csv.gz"],
      format: "parquet",
      outDir: "/data/calls",
      overwrite: false,
    });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(useConvert.getState().open).toBe(false));
  });
});
