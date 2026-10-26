// The keys that open the search window from anywhere: chosen in 设置, saved in app.toml
// (`launcher_key`), registered with the system by the shell (`set_launcher_keys`).
// Written as the shell reads them: modifiers, then the key's KeyboardEvent.code ("Super+Shift+KeyK");
// "": the usual (⌘⇧Space, Ctrl+Shift+Space).
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import * as api from "./api";
import { isMac } from "./keys";

/** The usual keys, as the shell has them (launcher_shortcut). */
export const USUAL = isMac ? "Super+Shift+Space" : "Control+Shift+Space";

let current = "";
const listeners = new Set<() => void>();
const changed = (keys: string) => {
  current = keys;
  listeners.forEach((f) => f());
};

/** The keys now, as saved ("": the usual). */
export function useLauncherKeys(): string {
  return useSyncExternalStore((f) => (listeners.add(f), () => void listeners.delete(f)), () => current);
}

/** At startup (in the main window): the saved keys, in place of the usual ones the shell starts with. */
export async function loadLauncherKeys() {
  const keys = (await api.prefs()).launcher_key ?? "";
  changed(keys);
  if (keys) await setKeys(keys).catch(() => {}); // taken since: the usual ones stay
}

/** Registers `keys` (null: none, while new ones are being pressed). Fails if they can't be had. */
export const setKeys = (keys: string | null) => invoke<void>("set_launcher_keys", { keys });

/** Opens the search window (as its keys do), searching `query` if given. */
export async function showLauncher(query?: string) {
  if (query !== undefined) await emitTo("launcher", "launcher-query", { query }).catch(() => {});
  await invoke<void>("show_launcher");
}

/** Makes `keys` open the search window, and remembers them. */
export async function chooseLauncherKeys(keys: string) {
  if (keys === USUAL) keys = "";
  await setKeys(keys);
  await api.setPrefs({ launcher_key: keys });
  changed(keys);
}

const MODIFIERS: Record<string, string> = {
  ControlLeft: "Control", ControlRight: "Control", AltLeft: "Alt", AltRight: "Alt",
  ShiftLeft: "Shift", ShiftRight: "Shift", MetaLeft: "Super", MetaRight: "Super",
};

/** What a key press would be as keys: null while only modifiers are down; "no modifier" for a
 * plain key (Shift alone doesn't count: Shift+K is typing). */
export function keysOf(e: KeyboardEvent): string | null | "no modifier" {
  if (MODIFIERS[e.code] || !e.code) return null;
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return "no modifier";
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  return [...mods, e.code].join("+");
}

const KEY_NAMES: Record<string, string> = {
  Space: "Space", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Backquote: "`", Minus: "-", Equal: "=", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Enter: isMac ? "↩" : "Enter", Tab: isMac ? "⇥" : "Tab", Backspace: isMac ? "⌫" : "Backspace", Escape: "Esc",
};

/** How keys are written: ⌃⌥⇧⌘K on a Mac, Ctrl+Alt+Shift+Win+K elsewhere. */
export function keysLabel(keys: string): string {
  const parts = (keys || USUAL).split("+");
  const code = parts.pop()!;
  const key = KEY_NAMES[code] ?? code.replace(/^Key|^Digit|^Numpad/, "");
  if (isMac) {
    const sym: Record<string, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" };
    return ["Control", "Alt", "Shift", "Super"].filter((m) => parts.includes(m)).map((m) => sym[m]).join("") + key;
  }
  const name: Record<string, string> = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Win" };
  return [...["Control", "Alt", "Shift", "Super"].filter((m) => parts.includes(m)).map((m) => name[m]), key].join("+");
}
