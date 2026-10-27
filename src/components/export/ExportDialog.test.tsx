import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, useExport, type ExportTarget } from "../../stores/export";
import { useNotice } from "../../stores/notice";
import { ExportDialog } from "./ExportDialog";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

function backend(opts: { path?: string | null; fail?: string } = {}) {
  const calls: Call[] = [];
  mockIPC((cmd, a) => {
    const args = a as Record<string, unknown>;
    calls.push({ cmd, args });
    if (cmd === "plugin:dialog|save") return opts.path === undefined ? "/out/x.csv" : opts.path;
    if (cmd === "plugin:event|listen") return 1;
    if (cmd === "export_view") {
      if (opts.fail === "cancelled") throw { kind: "cancelled", message: "Cancelled" };
      if (opts.fail) throw { kind: "query", message: opts.fail };
      return { path: "/out/x.csv", rows: 2, sheets: 0, rowsLeftOut: 0, elapsedMs: 12 };
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return calls;
}

const target = (over: Partial<ExportTarget> = {}): ExportTarget => ({
  datasetId: "ds-1",
  spec: { filters: [], sort: [{ column: "b", descending: true }], columns: ["b", "a"] },
  labels: { a: "Alpha" },
  title: "sales.csv",
  rowCount: 1500,
  selection: { columns: ["a"], rows: [[0, 2]] },
  ...over,
});

const exportCall = (calls: Call[]) =>
  calls.find((c) => c.cmd === "export_view")?.args as {
    request: Record<string, unknown> & { options: Record<string, unknown> };
  };

describe("ExportDialog", () => {
  beforeEach(() => useExport.setState({ target: null, job: null, defaults: DEFAULTS }));
  afterEach(() => clearMocks());

  it("exports the whole view with its columns, names, sort and options", async () => {
    const calls = backend();
    render(<ExportDialog />);
    useExport.getState().show(target());
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "Export" });
    expect(screen.getByRole("heading")).toHaveTextContent("Export sales.csv");
    expect(screen.getByText(/whole view: 1,500 rows, 2 columns/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Delimiter"), ";");
    await user.click(screen.getByRole("checkbox", { name: "Quote every value" }));
    await user.type(screen.getByLabelText("Date format"), "%d/%m/%Y");
    await user.click(screen.getByRole("button", { name: /Export 1,500 rows/ }));
    await waitFor(() => expect(useNotice.getState().text).toMatch(/Exported 2 rows to x.csv/));
    const save = calls.find((c) => c.cmd === "plugin:dialog|save")!.args.options as {
      defaultPath: string;
    };
    expect(save.defaultPath).toBe("sales-export.csv");
    expect(exportCall(calls).request).toMatchObject({
      datasetId: "ds-1",
      path: "/out/x.csv",
      format: "csv",
      spec: { sort: [{ column: "b", descending: true }], columns: ["b", "a"] },
      labels: { a: "Alpha" },
      totalRows: 1500,
      options: { header: true, delimiter: ";", quoteAll: true, dateFormat: "%d/%m/%Y" },
    });
    expect(exportCall(calls).request.options.rows).toBeUndefined();
    expect(useExport.getState().job).toBeNull();
    // The options are remembered.
    expect(useExport.getState().defaults).toMatchObject({ delimiter: ";", quoteAll: true });
  });

  it("exports only the selection; cancelling the save dialog does nothing", async () => {
    const calls = backend({ path: null });
    render(<ExportDialog />);
    useExport.getState().show(target());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Parquet" }));
    expect(screen.queryByLabelText("Delimiter")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /The selection: 2 rows, 1 column/ }));
    await user.click(screen.getByRole("button", { name: /Export 2 rows/ }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:dialog|save")).toBe(true));
    expect(calls.some((c) => c.cmd === "export_view")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Export" })).toBeInTheDocument();

    clearMocks();
    const next = backend();
    await user.click(screen.getByRole("button", { name: /Export 2 rows/ }));
    await waitFor(() => expect(exportCall(next)).toBeDefined());
    expect(exportCall(next).request).toMatchObject({
      format: "parquet",
      spec: { columns: ["a"] },
      totalRows: 2,
      options: { rows: [[0, 2]] },
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Export" })).not.toBeInTheDocument(),
    );
  });

  it("warns past Excel's sheet limit and offers splitting", async () => {
    backend();
    render(<ExportDialog />);
    useExport.getState().show(target({ rowCount: 2_500_000, selection: null }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Excel" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/1,048,575 rows per sheet/);
    expect(screen.getByRole("radio", { name: "Split into 3 sheets" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /Only the first/ }));
    expect(useExport.getState().defaults.splitSheets).toBe(false);
    // No selection to export.
    expect(screen.getByRole("radio", { name: /The selection/ })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "CSV" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports failures and cancels in words", async () => {
    backend({ fail: "The folder /nope does not exist." });
    await useExport.getState().start({
      datasetId: "ds-1",
      spec: {},
      labels: {},
      path: "/nope/x.csv",
      format: "csv",
      options: {},
    });
    expect(useNotice.getState().text).toBe("Couldn't export: The folder /nope does not exist.");
    clearMocks();
    backend({ fail: "cancelled" });
    await useExport.getState().start({
      datasetId: "ds-1",
      spec: {},
      labels: {},
      path: "/x.csv",
      format: "csv",
      options: {},
    });
    expect(useNotice.getState().text).toBe("Export cancelled");
  });
});
