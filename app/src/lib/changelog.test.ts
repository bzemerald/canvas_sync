import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0" }));
import { newer, noteItems, releases } from "./changelog";

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

describe("releases", () => {
  it("are the versions, newest first, without Unreleased", () => {
    const text = "# Changelog\n\nAbout it.\n\n## Unreleased\n\n- Soon.\n\n## 0.4.0 — 2026-11-15\n\n- One\n  line.\n- Two.\n\n## 0.3.0\n- Old.\n";
    expect(releases(text)).toEqual([
      { version: "0.4.0", date: "2026-11-15", items: ["One line.", "Two."] },
      { version: "0.3.0", date: "", items: ["Old."] },
    ]);
  });
  it("include the repo's CHANGELOG.md, built in", () => {
    expect(releases().some((r) => r.version === "0.4.0" && r.items.length > 0)).toBe(true);
  });
});

it("newer compares by number, not text", () => {
  expect(newer("0.10.0", "0.9.1")).toBe(true);
  expect(newer("0.4.0", "0.4.0")).toBe(false);
  expect(newer("0.3.9", "0.4.0")).toBe(false);
});
