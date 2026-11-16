import { describe, expect, it } from "vitest";
import { noteItems } from "./update";

describe("noteItems", () => {
  it("reads CHANGELOG.md's items, joining wrapped lines", () => {
    const body = "- Copy files with ⌘C, to paste them\r\n  in Finder.\r\n\r\n- Menus are the system's own.\n";
    expect(noteItems(body)).toEqual(["Copy files with ⌘C, to paste them in Finder.", "Menus are the system's own."]);
  });
  it("has none for no notes", () => {
    expect(noteItems(undefined)).toEqual([]);
    expect(noteItems("")).toEqual([]);
  });
});
