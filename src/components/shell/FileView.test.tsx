import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { decodeIpc } from "../../lib/arrow";
import type { SourceInfo } from "../../lib/files";
import { ipcBytes, sampleInfo } from "../../test/ipc";
import { FileView } from "./FileView";

describe("FileView", () => {
  it("renders preview rows with NULL distinct from empty text", () => {
    const preview = decodeIpc(ipcBytes({ id: [1, 2], name: ["", null] }));
    render(
      <FileView
        tab={{
          id: "t",
          title: "sales.csv.gz",
          path: "/data/sales.csv.gz",
          options: {},
          status: "ready",
          info: sampleInfo as SourceInfo,
          preview,
        }}
        onReopen={() => {}}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    expect(screen.getByText("null")).toHaveClass("italic");
    expect(screen.getByTitle("Empty string")).toBeInTheDocument();
    expect(screen.getByText(/csv · gzip · 5.0 GB/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import settings" })).toBeInTheDocument();
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
          error: "Row 3 has 4 columns, expected 3.",
        }}
        onReopen={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't open bad.csv");
    expect(screen.getByRole("alert")).toHaveTextContent("Row 3 has 4 columns, expected 3.");
    // CSV errors are often fixed in Import settings, so it stays reachable.
    expect(screen.getByRole("button", { name: "Import settings" })).toBeInTheDocument();
  });
});
