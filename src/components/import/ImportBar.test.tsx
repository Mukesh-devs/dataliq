import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ImportState } from "../../stores/tabs";
import { ImportBar } from "./ImportBar";

const running: ImportState = { jobId: "j", status: "running", percent: 42.4, elapsedMs: 12_000 };
const noop = () => {};

describe("ImportBar", () => {
  it("shows percent, elapsed time and a cancel button while importing", async () => {
    const onCancel = vi.fn();
    render(
      <ImportBar
        state={running}
        quiet={false}
        onCancel={onCancel}
        onReadDirect={noop}
        onRetry={noop}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Importing full file" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveTextContent("42% · 12.0 s");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("is indeterminate when progress is unknown and hidden for small files", () => {
    const { rerender } = render(
      <ImportBar
        state={{ ...running, percent: null }}
        quiet={false}
        onCancel={noop}
        onReadDirect={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    rerender(
      <ImportBar state={running} quiet onCancel={noop} onReadDirect={noop} onRetry={noop} />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("offers reading directly when disk space is low", async () => {
    const onReadDirect = vi.fn();
    render(
      <ImportBar
        state={{
          ...running,
          status: "error",
          errorKind: "low-disk",
          error: "Not enough free disk space to import this file.",
        }}
        quiet
        onCancel={noop}
        onReadDirect={onReadDirect}
        onRetry={noop}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Not enough free disk space");
    await userEvent.click(screen.getByRole("button", { name: "Read directly" }));
    expect(onReadDirect).toHaveBeenCalledOnce();
  });

  it("lets the user import again after cancelling", async () => {
    const onRetry = vi.fn();
    render(
      <ImportBar
        state={{ ...running, status: "cancelled" }}
        quiet={false}
        onCancel={noop}
        onReadDirect={noop}
        onRetry={onRetry}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Import again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
