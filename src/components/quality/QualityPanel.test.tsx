import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { duplicatesSql, type QualityReport } from "../../lib/quality";
import { QualityPanel } from "./QualityPanel";

const report: QualityReport = {
  rows: 22,
  elapsedMs: 9,
  warnings: [
    {
      kind: "spaces",
      column: "name",
      rows: 3,
      message: "3 values have spaces at the start or end",
      filters: [{ column: "name", op: "regex", pattern: "^\\s|\\s$" }],
      fix: { op: "trim", column: "name" },
    },
    {
      kind: "outliers",
      column: "score",
      rows: 1,
      message: "1 value far outside the usual range (below 1 or above 99)",
      filters: [{ column: "score", op: "notNull" }],
      fix: null,
    },
    {
      kind: "duplicates",
      column: null,
      rows: 2,
      message: "2 rows are exact copies of an earlier row",
      filters: [],
      fix: { op: "removeDuplicates" },
    },
  ],
};

function setup(props: Partial<Parameters<typeof QualityPanel>[0]> = {}) {
  const handlers = {
    onShow: vi.fn(),
    onShowCopies: vi.fn(),
    onFix: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
  };
  render(<QualityPanel report={report} loading={false} {...handlers} {...props} />);
  return { ...handlers, user: userEvent.setup() };
}

describe("QualityPanel", () => {
  it("lists warnings with their rows and fixes", async () => {
    const { onShow, onShowCopies, onFix, user } = setup();
    expect(screen.getByRole("status")).toHaveTextContent("3 warnings in 22 rows · 9 ms");
    const items = within(screen.getByRole("list", { name: "Warnings" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Stray spaces");
    expect(items[0]).toHaveTextContent("name");
    await user.click(within(items[0]!).getByRole("button", { name: "Show 3 rows" }));
    expect(onShow).toHaveBeenCalledWith(report.warnings[0]);
    await user.click(within(items[0]!).getByRole("button", { name: /Fix: Trim spaces in “name”/ }));
    expect(onFix).toHaveBeenCalledWith({ op: "trim", column: "name" });
    // One row; no fix for outliers.
    expect(within(items[1]!).getByRole("button", { name: "Show the row" })).toBeInTheDocument();
    expect(within(items[1]!).queryByRole("button", { name: /Fix/ })).toBeNull();
    // Duplicates are shown in SQL.
    await user.click(within(items[2]!).getByRole("button", { name: "Show copies in SQL" }));
    expect(onShowCopies).toHaveBeenCalled();
    expect(within(items[2]!).queryByRole("button", { name: /^Show \d/ })).toBeNull();
  });

  it("says when there is nothing to fix, and shows errors", () => {
    setup({ report: { rows: 10, elapsedMs: 1, warnings: [] }, error: "Out of memory" });
    expect(screen.getByRole("status")).toHaveTextContent("No problems in 10 rows");
    expect(screen.getByText(/Every column looks consistent/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Out of memory");
  });

  it("lists duplicated rows once each with their copies", () => {
    expect(duplicatesSql('my "t"')).toBe(
      "-- Rows that appear more than once, with their number of copies\n" +
        'SELECT *, count(*) AS copies\nFROM "my ""t"""\nGROUP BY ALL\nHAVING count(*) > 1\nORDER BY copies DESC',
    );
  });
});
