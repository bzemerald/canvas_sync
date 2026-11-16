// Keyboard behavior follows the platform's own file manager: Finder on macOS, File
// Explorer on Windows, and the Explorer-like conventions GNOME Files / Dolphin share on Linux.
import { t } from "./i18n";

export type Platform = "mac" | "windows" | "linux";

export const platform: Platform = navigator.userAgent.includes("Mac")
  ? "mac"
  : navigator.userAgent.includes("Windows")
    ? "windows"
    : "linux";
export const isMac = platform === "mac";

/** ⌘ on macOS, Ctrl elsewhere. */
export const primary = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

type Key = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export type FileCommand = "open" | "rename" | "preview" | "delete" | "parent" | "selectAll" | "copy";

/** What a key means in a file list or grid (arrows are handled by the list itself). */
export function fileCommand(e: Key): FileCommand | null {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (isMac) {
    if (e.metaKey && (k === "o" || k === "ArrowDown")) return "open";
    if (e.metaKey && k === "ArrowUp") return "parent";
    if (e.metaKey && k === "Backspace") return "delete";
    if (e.metaKey && k === "a") return "selectAll";
    if (e.metaKey && k === "c" && !e.shiftKey && !e.altKey) return "copy";
    if (k === "Enter" && !e.metaKey && !e.ctrlKey) return "rename";
    if (k === " ") return "preview";
    return null;
  }
  if (k === "Enter" && !e.altKey && !e.ctrlKey) return "open";
  if (k === "F2") return "rename";
  if (k === "Delete") return "delete";
  if (e.altKey && k === "ArrowUp") return "parent";
  if (e.ctrlKey && k === "a") return "selectAll";
  if (e.ctrlKey && k === "c" && !e.shiftKey && !e.altKey) return "copy";
  return null;
}

export type AppCommand = "back" | "forward" | "search" | "toggleChanges" | "settings" | "sync" | "prevCourse" | "nextCourse" | "shortcuts";

/** Window-wide keys. `typing` is true when the key went to a text field. */
export function appCommand(e: Key, typing: boolean): AppCommand | null {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (isMac) {
    if (e.metaKey && k === "[") return "back";
    if (e.metaKey && k === "]") return "forward";
    if (e.metaKey && k === "f") return "search";
    if (e.metaKey && e.shiftKey && e.code === "Period") return "toggleChanges"; // like ⌘⇧. for hidden files
    if (e.metaKey && k === ",") return "settings";
    if (e.metaKey && k === "r") return "sync";
    if (e.metaKey && e.altKey && k === "ArrowUp" && !typing) return "prevCourse";
    if (e.metaKey && e.altKey && k === "ArrowDown" && !typing) return "nextCourse";
    if (e.metaKey && e.code === "Slash") return "shortcuts";
    return null;
  }
  if (e.altKey && k === "ArrowLeft") return "back";
  if (e.altKey && k === "ArrowRight") return "forward";
  if (k === "Backspace" && !typing && platform === "windows") return "back";
  if (e.ctrlKey && k === "f") return "search";
  if (e.ctrlKey && k === "h" && platform === "linux") return "toggleChanges"; // like Ctrl+H for hidden files
  if (e.ctrlKey && k === ",") return "settings";
  if ((e.ctrlKey && k === "r") || k === "F5") return "sync";
  if (e.ctrlKey && e.shiftKey && k === "ArrowUp" && !typing) return "prevCourse";
  if (e.ctrlKey && e.shiftKey && k === "ArrowDown" && !typing) return "nextCourse";
  if (e.ctrlKey && e.code === "Slash") return "shortcuts";
  return null;
}

/** A course's tabs, as a browser's: 1-9 (9: the last), the next / previous one, a new one. */
export type TabCommand = number | "next" | "prev" | "new";

export function tabCommand(e: Key): TabCommand | null {
  if (e.code === "KeyT" && primary(e) && !e.shiftKey && !e.altKey) return "new";
  const digit = e.code?.match(/^Digit([1-9])$/);
  if (digit && primary(e) && !e.shiftKey && !e.altKey) return Number(digit[1]);
  if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? "prev" : "next";
  if (isMac && e.metaKey && e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) return e.code === "BracketRight" ? "next" : "prev";
  if (!isMac && e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) return e.key === "PageDown" ? "next" : "prev";
  return null;
}

/** How to write each shortcut in menus and tooltips. */
export const shortcut = isMac
  ? {
      open: "⌘O", copy: "⌘C", rename: "↩", preview: t("Space"), delete: "⌘⌫", parent: "⌘↑", back: "⌘[", forward: "⌘]", search: "⌘F",
      toggleChanges: "⌘⇧.", settings: "⌘,", sync: "⌘R", prevCourse: "⌥⌘↑", nextCourse: "⌥⌘↓", shortcuts: "⌘/",
      tab: "⌘1…9", newTab: "⌘T", nextTab: "⌃⇥ / ⌘⇧]", prevTab: "⌃⇧⇥ / ⌘⇧[", up: "↑", down: "↓",
    }
  : {
      open: "Enter", copy: "Ctrl+C", rename: "F2", preview: "", delete: "Delete", parent: "Alt+↑", back: "Alt+←", forward: "Alt+→", search: "Ctrl+F",
      toggleChanges: platform === "linux" ? "Ctrl+H" : "", settings: "Ctrl+,", sync: "Ctrl+R", prevCourse: "Ctrl+Shift+↑",
      nextCourse: "Ctrl+Shift+↓", shortcuts: "Ctrl+/", tab: "Ctrl+1…9", newTab: "Ctrl+T", nextTab: "Ctrl+Tab", prevTab: "Ctrl+Shift+Tab", up: "↑", down: "↓",
    };

/** What Finder and Explorer call copying. */
export const copyName = isMac ? t("Copy@@mac") : t("Copy");
export const trashName = isMac ? t("Trash") : t("Recycle Bin");
export const fileManager = isMac ? "Finder" : platform === "windows" ? t("File Explorer") : t("Files@@manager");
