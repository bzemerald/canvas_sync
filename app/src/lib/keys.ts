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

export type FileCommand = "open" | "rename" | "preview" | "delete" | "parent" | "selectAll";

/** What a key means in a file list or grid (arrows are handled by the list itself). */
export function fileCommand(e: Key): FileCommand | null {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (isMac) {
    if (e.metaKey && (k === "o" || k === "ArrowDown")) return "open";
    if (e.metaKey && k === "ArrowUp") return "parent";
    if (e.metaKey && k === "Backspace") return "delete";
    if (e.metaKey && k === "a") return "selectAll";
    if (k === "Enter" && !e.metaKey && !e.ctrlKey) return "rename";
    if (k === " ") return "preview";
    return null;
  }
  if (k === "Enter" && !e.altKey && !e.ctrlKey) return "open";
  if (k === "F2") return "rename";
  if (k === "Delete") return "delete";
  if (e.altKey && k === "ArrowUp") return "parent";
  if (e.ctrlKey && k === "a") return "selectAll";
  return null;
}

export type AppCommand = "back" | "forward" | "search" | "toggleChanges" | "settings";

/** Window-wide keys. `typing` is true when the key went to a text field. */
export function appCommand(e: Key, typing: boolean): AppCommand | null {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (isMac) {
    if (e.metaKey && k === "[") return "back";
    if (e.metaKey && k === "]") return "forward";
    if (e.metaKey && k === "f") return "search";
    if (e.metaKey && e.shiftKey && e.code === "Period") return "toggleChanges"; // like ⌘⇧. for hidden files
    if (e.metaKey && k === ",") return "settings";
    return null;
  }
  if (e.altKey && k === "ArrowLeft") return "back";
  if (e.altKey && k === "ArrowRight") return "forward";
  if (k === "Backspace" && !typing && platform === "windows") return "back";
  if (e.ctrlKey && k === "f") return "search";
  if (e.ctrlKey && k === "h" && platform === "linux") return "toggleChanges"; // like Ctrl+H for hidden files
  if (e.ctrlKey && k === ",") return "settings";
  return null;
}

/** How to write each shortcut in menus and tooltips. */
export const shortcut = isMac
  ? {
      open: "⌘O", rename: "↩", preview: t("空格"), delete: "⌘⌫", parent: "⌘↑", back: "⌘[", forward: "⌘]", search: "⌘F",
      toggleChanges: "⌘⇧.", settings: "⌘,", launcher: "⌘⇧Space",
    }
  : {
      open: "Enter", rename: "F2", preview: "", delete: "Delete", parent: "Alt+↑", back: "Alt+←", forward: "Alt+→", search: "Ctrl+F",
      toggleChanges: platform === "linux" ? "Ctrl+H" : "", settings: "Ctrl+,", launcher: "Ctrl+Shift+Space",
    };

export const trashName = isMac ? t("废纸篓") : t("回收站");
export const fileManager = isMac ? "Finder" : platform === "windows" ? t("文件资源管理器") : t("文件管理器");
