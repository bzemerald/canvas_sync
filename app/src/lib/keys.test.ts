import { describe, expect, it, vi } from "vitest";
import { appCommand, isMac, tabCommand } from "./keys";

vi.mock("./i18n", () => ({ t: (s: string) => s })); // (it needs a window)

// (Tests run as Linux: Ctrl where macOS has ⌘.)
const key = (key: string, mods: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe.skipIf(isMac)("tabCommand", () => {
  it("numbers the tabs, by the digit key whatever the layout gives", () => {
    expect(tabCommand(key("1", { code: "Digit1", ctrlKey: true }))).toBe(1);
    expect(tabCommand(key("&", { code: "Digit9", ctrlKey: true }))).toBe(9);
    expect(tabCommand(key("1", { code: "Digit1" }))).toBeNull(); // typed, not a shortcut
    expect(tabCommand(key("0", { code: "Digit0", ctrlKey: true }))).toBeNull();
  });
  it("goes round with Ctrl+Tab and Ctrl+PageDown", () => {
    expect(tabCommand(key("Tab", { ctrlKey: true }))).toBe("next");
    expect(tabCommand(key("Tab", { ctrlKey: true, shiftKey: true }))).toBe("prev");
    expect(tabCommand(key("PageUp", { ctrlKey: true }))).toBe("prev");
    expect(tabCommand(key("Tab"))).toBeNull();
  });
  it("opens a new tab with Ctrl+T", () => {
    expect(tabCommand(key("t", { code: "KeyT", ctrlKey: true }))).toBe("new");
    expect(tabCommand(key("T", { code: "KeyT", ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe.skipIf(isMac)("appCommand", () => {
  it("syncs, and goes through the courses unless typing", () => {
    expect(appCommand(key("r", { ctrlKey: true }), false)).toBe("sync");
    expect(appCommand(key("F5"), true)).toBe("sync");
    expect(appCommand(key("ArrowDown", { ctrlKey: true, shiftKey: true }), false)).toBe("nextCourse");
    expect(appCommand(key("ArrowDown", { ctrlKey: true, shiftKey: true }), true)).toBeNull(); // selecting text
    expect(appCommand(key("/", { code: "Slash", ctrlKey: true }), false)).toBe("shortcuts");
  });
});
