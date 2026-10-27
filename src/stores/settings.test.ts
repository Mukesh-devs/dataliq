import { beforeEach, describe, expect, it } from "vitest";
import { resolveTheme, useSettings } from "./settings";

describe("settings store", () => {
  beforeEach(() => useSettings.setState({ theme: "system", density: "comfortable" }));

  it("cycles through system, light and dark", () => {
    const { cycleTheme } = useSettings.getState();
    cycleTheme();
    expect(useSettings.getState().theme).toBe("light");
    cycleTheme();
    expect(useSettings.getState().theme).toBe("dark");
    cycleTheme();
    expect(useSettings.getState().theme).toBe("system");
  });

  it("resolves the system preference from the OS", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
