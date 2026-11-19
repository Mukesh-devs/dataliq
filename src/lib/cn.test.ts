import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("skips falsy values", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("lets a class passed in replace the default that sets the same thing", () => {
    // IconButton's 28 px default, and the status bar's 20 px.
    expect(cn("inline-flex size-7 text-fg-muted", "size-5")).toBe(
      "inline-flex text-fg-muted size-5",
    );
    expect(cn("text-fg-muted hover:text-fg", "text-fg")).toBe("hover:text-fg text-fg");
    expect(cn("rounded-[var(--radius)]", "rounded-[var(--radius-sm)]")).toBe(
      "rounded-[var(--radius-sm)]",
    );
  });

  it("keeps classes that set different things", () => {
    expect(cn("text-[13px] text-fg", "border border-border")).toBe(
      "text-[13px] text-fg border border-border",
    );
  });
});
