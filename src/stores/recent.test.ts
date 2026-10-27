import { beforeEach, describe, expect, it } from "vitest";
import { useRecent } from "./recent";

describe("recent files", () => {
  beforeEach(() => useRecent.setState({ files: [] }));

  it("keeps the newest first without duplicates, up to 10", () => {
    const { add } = useRecent.getState();
    for (let i = 0; i < 12; i++) add(`/d/f${i}.csv`);
    add("/d/f5.csv");
    const files = useRecent.getState().files;
    expect(files).toHaveLength(10);
    expect(files[0]).toMatchObject({ path: "/d/f5.csv", name: "f5.csv" });
    expect(files.filter((f) => f.path === "/d/f5.csv")).toHaveLength(1);
    expect(files.some((f) => f.path === "/d/f0.csv")).toBe(false);
  });

  it("removes entries", () => {
    useRecent.getState().add("C:\\data\\a.csv");
    useRecent.getState().remove("C:\\data\\a.csv");
    expect(useRecent.getState().files).toEqual([]);
  });
});
