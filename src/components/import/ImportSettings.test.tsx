import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { sampleInfo } from "../../test/ipc";
import { ImportSettings } from "./ImportSettings";

describe("ImportSettings", () => {
  it("shows detected values and applies overrides", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<ImportSettings options={{}} sniffed={sampleInfo.sniffed} onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Import settings" }));
    expect(screen.getByText("Detected: ;")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Delimiter"), "\t");
    await user.selectOptions(screen.getByLabelText("Encoding"), "latin-1");
    await user.type(screen.getByLabelText("Skip rows"), "2");
    await user.click(screen.getByLabelText("Ignore bad rows"));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({
      delimiter: "\t",
      encoding: "latin-1",
      skipRows: 2,
      ignoreErrors: true,
    });
  });

  it("reset clears overrides back to auto-detect", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <ImportSettings
        options={{ delimiter: "|", header: false }}
        sniffed={null}
        onApply={onApply}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Import settings" }));
    expect(screen.getByLabelText("Delimiter")).toHaveValue("|");
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({});
  });
});
