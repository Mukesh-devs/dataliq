import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExcelSettings } from "./ExcelSettings";

const info = { sheets: ["Orders", "Notes"], sheet: "Orders", headerRow: 1 };

describe("ExcelSettings", () => {
  it("switches sheets with fresh header detection", async () => {
    const onChange = vi.fn();
    render(<ExcelSettings info={info} onChange={onChange} />);
    expect(screen.getByLabelText("Sheet")).toHaveValue("Orders");
    await userEvent.selectOptions(screen.getByLabelText("Sheet"), "Notes");
    expect(onChange).toHaveBeenCalledWith({ sheet: "Notes" });
  });

  it("chooses the header row or none", async () => {
    const onChange = vi.fn();
    render(<ExcelSettings info={info} onChange={onChange} />);
    expect(screen.getByLabelText("Header row")).toHaveValue("1");
    await userEvent.selectOptions(screen.getByLabelText("Header row"), "3");
    expect(onChange).toHaveBeenLastCalledWith({ sheet: "Orders", headerRow: 3 });
    await userEvent.selectOptions(screen.getByLabelText("Header row"), "0");
    expect(onChange).toHaveBeenLastCalledWith({ sheet: "Orders", headerRow: 0 });
  });
});
