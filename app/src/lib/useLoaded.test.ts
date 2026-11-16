import { describe, expect, it } from "vitest";
import { among } from "./useLoaded";

describe("what a reload reaches", () => {
  it("is everything when nothing is named", () => {
    expect(among("overview:3", [])).toBe(true);
    expect(among("courses", [])).toBe(true);
  });
  it("is a key named, and what's under it", () => {
    expect(among("courses", ["courses"])).toBe(true);
    expect(among("overview:3", ["overview"])).toBe(true);
    expect(among("items:3:announcement", ["items:3"])).toBe(true);
  });
  it("is not a key that only starts the same", () => {
    expect(among("overviews", ["overview"])).toBe(false);
    expect(among("items:31:page", ["items:3"])).toBe(false);
    expect(among("new-files", ["courses", "overview"])).toBe(false);
  });
});
