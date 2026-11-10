import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { asJob, useJobs } from "../../stores/jobs";
import { JobsIndicator } from "../shell/JobsIndicator";
import { ToolDialog } from "./ToolDialog";

describe("ToolDialog", () => {
  afterEach(() => {
    clearMocks();
    useJobs.setState({ jobs: [] });
  });

  it("shows the time running and Stop cancels the query", async () => {
    let fail!: (e: unknown) => void;
    mockIPC((cmd) => {
      if (cmd === "cancel_query") fail({ kind: "cancelled", message: "Cancelled" });
      return true;
    });
    const user = userEvent.setup();
    render(
      <>
        <ToolDialog
          title="Group by"
          runLabel="Group"
          onClose={() => {}}
          onRun={() =>
            asJob(
              "Grouping a.csv",
              "tool-9",
              () => new Promise<void>((_, reject) => (fail = reject)),
            )
          }
        >
          <span>form</span>
        </ToolDialog>
        <JobsIndicator />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Group" }));
    expect(await screen.findByText(/Running… \d/)).toBeTruthy();
    expect(screen.getByTestId("jobs").textContent).toContain("Grouping a.csv…");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Stopped."));
    expect(screen.queryByTestId("jobs")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
