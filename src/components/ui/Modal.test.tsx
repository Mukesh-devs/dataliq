import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

function Harness({ dismissable = true, onClose = () => {} }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">Outside</button>
      <Modal
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) onClose();
        }}
        title="Export orders.csv"
        label="Export"
        dismissable={dismissable}
      >
        <input aria-label="Delimiter" />
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("is a named dialog with a title bar, and focuses its first field", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Export" });
    expect(dialog).toHaveTextContent("Export orders.csv");
    expect(screen.getByLabelText("Delimiter")).toHaveFocus();
  });

  it("doesn't close from a click outside", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    // The window behind takes no clicks while a dialog is open; click it anyway.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("button", { name: "Outside", hidden: true }));
    expect(screen.getByRole("dialog", { name: "Export" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes with Esc and with ✕", async () => {
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
    unmount();

    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the keyboard inside until it closes", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    // Delimiter → Cancel → ✕ → back to Delimiter, never "Outside".
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Delimiter")).toHaveFocus();
  });

  it("can't be dismissed while busy: no ✕, and Esc does nothing", async () => {
    const onClose = vi.fn();
    render(<Harness dismissable={false} onClose={onClose} />);
    expect(screen.queryByRole("button", { name: "Close dialog" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Export" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
