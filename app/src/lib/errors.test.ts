import { describe, expect, it, vi } from "vitest";
import { friendly } from "./errors";

vi.mock("./i18n", () => ({ t: (s: string, v: Record<string, string> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]) })); // (it needs a window)

describe("friendly", () => {
  it("says where the files of a move that couldn't go back are", () => {
    const said = friendly("partly moved\n/Users/me/Canvas\n/Volumes/Disk/Canvas");
    expect(said).toContain("/Users/me/Canvas");
    expect(said).toContain("/Volumes/Disk/Canvas");
  });
  it("leaves what it doesn't know as it is", () => {
    expect(friendly("something else")).toBe("something else");
  });
});
