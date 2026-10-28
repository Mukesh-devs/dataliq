import { describe, expect, it } from "vitest";
import { baseName } from "./files";
import { isUrl, urlName } from "./remote";

describe("URLs", () => {
  it("are http(s) or s3", () => {
    expect(isUrl("https://example.com/a.csv")).toBe(true);
    expect(isUrl("HTTP://example.com/a.csv")).toBe(true);
    expect(isUrl("s3://bucket/a.parquet")).toBe(true);
    expect(isUrl("/data/https.csv")).toBe(false);
    expect(isUrl("C:\\data\\a.csv")).toBe(false);
  });

  it("are named after their file", () => {
    expect(urlName("https://x.org/data/sales.csv.gz?token=1#top")).toBe("sales.csv.gz");
    expect(urlName("s3://bucket/")).toBe("bucket");
    expect(baseName("https://x.org/a/b.parquet?x=1")).toBe("b.parquet");
    expect(baseName("/data/b.parquet")).toBe("b.parquet");
  });
});
