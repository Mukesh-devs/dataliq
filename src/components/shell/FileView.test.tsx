import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeIpc } from "../../lib/arrow";
import type { SourceInfo } from "../../lib/files";
import { ipcBytes, sampleInfo } from "../../test/ipc";
import type { RowSource } from "../grid/rowSource";
import { PagedRowSource, StaticRowSource } from "../grid/rowSource";
import { FileView } from "./FileView";

// The canvas grid can't render in jsdom; capture the source it receives.
const received: RowSource[] = [];
vi.mock("../grid/DataGrid", async () => {
  const { forwardRef } = await import("react");
  return {
    DataGrid: forwardRef(function FakeGrid({ source }: { source: RowSource }) {
      received.push(source);
      return <div data-testid="data-grid">{source.rowCount} rows</div>;
    }),
  };
});

const preview = decodeIpc(ipcBytes({ id: [1, 2], name: ["", null] }));
const baseTab = {
  id: "t",
  title: "sales.csv.gz",
  path: "/data/sales.csv.gz",
  options: {},
  status: "ready" as const,
  preview,
};

describe("FileView", () => {
  it("shows the preview in the grid until the full data is available", () => {
    render(<FileView tab={{ ...baseTab, info: sampleInfo as SourceInfo }} onReopen={() => {}} />);
    expect(screen.getByTestId("data-grid")).toHaveTextContent("2 rows");
    expect(received.at(-1)).toBeInstanceOf(StaticRowSource);
    expect(screen.getByText(/csv · gzip · 5.0 GB/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import settings" })).toBeInTheDocument();
  });

  it("pages the full dataset once it exists", () => {
    const info = { ...sampleInfo, dataset: { id: "ds1", rowCount: 50_000_000 } } as SourceInfo;
    render(<FileView tab={{ ...baseTab, info }} onReopen={() => {}} />);
    expect(screen.getByTestId("data-grid")).toHaveTextContent("50000000 rows");
    const source = received.at(-1);
    expect(source).toBeInstanceOf(PagedRowSource);
    expect(source?.columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("shows errors in plain words", () => {
    render(
      <FileView
        tab={{
          id: "t",
          title: "bad.csv",
          path: "/d/bad.csv",
          options: {},
          status: "error",
          error: "Line 7 has 4 columns, expected 3.",
        }}
        onReopen={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't open bad.csv");
    expect(screen.getByRole("alert")).toHaveTextContent("Line 7 has 4 columns, expected 3.");
    // CSV errors are often fixed in Import settings, so it stays reachable.
    expect(screen.getByRole("button", { name: "Import settings" })).toBeInTheDocument();
  });
});
