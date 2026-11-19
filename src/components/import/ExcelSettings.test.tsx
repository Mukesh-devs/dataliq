import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExcelSettings } from "./ExcelSettings";

const info = { sheets: ["Orders", "Notes"], sheet: "Orders", headerRow: 12 };

describe("ExcelSettings", () => {
  it("switches sheets with fresh header detection", async () => {
    const onChange = vi.fn();
    render(<ExcelSettings info={info} onChange={onChange} />);
    expect(screen.getByLabelText("Sheet")).toHaveValue("Orders");
    await userEvent.selectOptions(screen.getByLabelText("Sheet"), "Notes");
    expect(onChange).toHaveBeenCalledWith({ sheet: "Notes" });
  });

  it("shows the header row found, and takes any row as a number on Enter", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ExcelSettings info={info} onChange={onChange} />);
    const box = screen.getByLabelText("Header row");
    expect(box).toHaveValue(12);
    await userEvent.clear(box);
    await userEvent.type(box, "1{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({ sheet: "Orders", headerRow: 1 });
    // The file is read again with row 1; going back to 12 is still possible.
    rerender(<ExcelSettings info={{ ...info, headerRow: 1 }} auto={false} onChange={onChange} />);
    expect(box).toHaveValue(1);
    await userEvent.clear(box);
    await userEvent.type(box, "12{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({ sheet: "Orders", headerRow: 12 });
  });

  it("applies on leaving the box; 0 is no header row", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ExcelSettings info={info} onChange={onChange} />);
    const box = screen.getByLabelText("Header row");
    await userEvent.clear(box);
    await userEvent.type(box, "0");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onChange).toHaveBeenLastCalledWith({ sheet: "Orders", headerRow: 0 });
    rerender(<ExcelSettings info={{ ...info, headerRow: 0 }} auto={false} onChange={onChange} />);
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("puts the row back on Escape, and for anything that isn't a row", async () => {
    const onChange = vi.fn();
    render(<ExcelSettings info={info} onChange={onChange} />);
    const box = screen.getByLabelText("Header row");
    await userEvent.clear(box);
    await userEvent.type(box, "40{Escape}");
    expect(box).toHaveValue(12);
    await userEvent.clear(box);
    await userEvent.type(box, "2000000{Enter}");
    expect(box).toHaveValue(12);
    await userEvent.clear(box);
    await userEvent.tab();
    expect(box).toHaveValue(12);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("finds the header row again once one was chosen", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ExcelSettings info={info} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "Find the header row again" })).toBeNull();
    rerender(<ExcelSettings info={info} auto={false} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Find the header row again" }));
    expect(onChange).toHaveBeenLastCalledWith({ sheet: "Orders" });
  });
});
