import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ColumnProfile } from "../../lib/view";
import { ProfilePanel } from "./ProfilePanel";

const amount: ColumnProfile = {
  column: "amount",
  type: "DOUBLE",
  kind: "number",
  rows: 1000,
  nulls: 50,
  distinct: 12_345_678,
  distinctApprox: true,
  min: "0.5",
  max: "99.5",
  mean: 50.25,
  stddev: 28.9,
  histogram: [
    { lo: 0, hi: 50, count: 600 },
    { lo: 50, hi: 100, count: 350 },
  ],
  top: [
    { value: "1.5", count: 40 },
    { value: null, count: 50 },
    { value: "", count: 3 },
  ],
  topTruncated: true,
  elapsedMs: 1250,
};

function stat(name: string) {
  const term = screen.getByText(name, { selector: "dt" });
  return term.nextElementSibling?.textContent;
}

describe("ProfilePanel", () => {
  it("shows the statistics, distribution and most common values", () => {
    render(<ProfilePanel title="Amount" profile={amount} onClose={() => {}} />);
    const panel = screen.getByRole("complementary", { name: "Profile of Amount" });
    expect(panel).toHaveTextContent("DOUBLE");
    expect(stat("Rows")).toBe("1,000");
    expect(stat("Nulls")).toBe("50 (5.0%)");
    expect(stat("Distinct")).toBe("≈ 12,345,678");
    expect(stat("Min")).toBe("0.5");
    expect(stat("Max")).toBe("99.5");
    expect(stat("Mean")).toBe("50.25");

    const bars = within(screen.getByRole("region", { name: "Histogram" })).getAllByRole("listitem");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAccessibleName("0 to 50: 600");
    expect(bars[0]).toHaveStyle({ height: "100%" });

    const top = within(screen.getByRole("region", { name: "Top values" })).getAllByRole("listitem");
    expect(top.map((li) => li.textContent)).toEqual([
      "1.540 · 4.0%",
      "null50 · 5.0%",
      '""3 · 0.3%',
    ]);
    expect(panel).toHaveTextContent("Showing the 10 most common values");
    expect(panel).toHaveTextContent("1.3 s");
  });

  it("leaves out what doesn't apply to the column", () => {
    const text: ColumnProfile = {
      ...amount,
      kind: "text",
      type: "VARCHAR",
      distinctApprox: false,
      distinct: 3,
      mean: null,
      stddev: null,
      histogram: null,
      top: [],
      topTruncated: false,
    };
    render(<ProfilePanel title="name" profile={text} onClose={() => {}} />);
    expect(screen.queryByText("Mean")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Histogram" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Top values" })).not.toBeInTheDocument();
    expect(stat("Distinct")).toBe("3");
  });

  it("shows loading and errors, and closes", async () => {
    const onClose = vi.fn();
    render(<ProfilePanel title="x" loading error="The view failed." onClose={onClose} />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The view failed.");
    await userEvent.click(screen.getByRole("button", { name: "Close profile" }));
    expect(onClose).toHaveBeenCalled();
  });
});
