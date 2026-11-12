import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isMac } from "../lib/keys";

export type MenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string; checked?: boolean }
  | "separator";

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** A context menu at the mouse: the system's own on macOS, else ours. */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  return isMac ? <NativeMenu menu={menu} onClose={onClose} /> : <WebMenu menu={menu} onClose={onClose} />;
}

/** A hint as an accelerator, shown at the item's right. Only ones with ⌘: a bare key (↩, space)
 * would act inside the open menu, where ↩ picks the highlighted item. */
export function accelerator(hint?: string): string | undefined {
  if (!hint?.startsWith("⌘")) return undefined;
  const mods: Record<string, string> = { "⌘": "Cmd", "⇧": "Shift", "⌥": "Alt", "⌃": "Ctrl" };
  const keys: Record<string, string> = { "⌫": "Backspace", ".": "Period", ",": "Comma", "/": "Slash", "↑": "Up", "↓": "Down", "[": "BracketLeft", "]": "BracketRight" };
  const parts: string[] = [];
  for (const ch of hint) {
    if (mods[ch]) parts.push(mods[ch]);
    else if (keys[ch] || /^[A-Z0-9]$/.test(ch)) parts.push(keys[ch] ?? ch);
    else return undefined;
  }
  return parts.join("+");
}

/** NSMenu, popped up at the mouse. The popup returns once it closes. */
function NativeMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const shown = useRef<MenuState | null>(null); // (StrictMode runs effects twice)
  const last = useRef<Menu | null>(null); // closed when the next opens: an item's action may come after the popup returns

  useEffect(() => {
    if (!menu || shown.current === menu) return;
    shown.current = menu;
    void (async () => {
      try {
        const native = await Menu.new({
          items: menu.items.map((item) =>
            item === "separator"
              ? { item: "Separator" as const }
              : {
                  text: item.label,
                  enabled: !item.disabled,
                  accelerator: accelerator(item.hint),
                  ...(item.checked !== undefined ? { checked: item.checked } : {}),
                  action: () => item.onSelect(),
                },
          ),
        });
        void last.current?.close();
        last.current = native;
        await native.popup(new LogicalPosition(menu.x, menu.y));
      } finally {
        onClose();
      }
    })();
  }, [menu, onClose]);

  return null;
}

/** Ours. Closes on click elsewhere, Escape, scroll or blur. */
function WebMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 8),
      y: Math.min(menu.y, window.innerHeight - height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      // Only the window losing focus. A capturing listener also hears every element's blur,
      // e.g. the file list losing focus as you press a menu item, which would close the
      // menu before the click lands.
      if (e.type === "blur" && e.target !== window) return;
      onClose();
    };
    const events = ["mousedown", "keydown", "blur", "wheel"];
    events.forEach((t) => window.addEventListener(t, close, true));
    return () => events.forEach((t) => window.removeEventListener(t, close, true));
  }, [menu, onClose]);

  if (!menu) return null;
  const checks = menu.items.some((i) => i !== "separator" && i.checked !== undefined); // a column for ✓
  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-48 rounded-lg border border-line bg-panel p-1 text-sm shadow-xl"
    >
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={i}
            role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            aria-checked={item.checked}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left hover:bg-selected disabled:opacity-40 disabled:hover:bg-transparent ${item.danger ? "text-danger" : "text-fg"}`}
          >
            <span className="flex items-center gap-2">
              {checks && <Check className={`size-3.5 shrink-0 ${item.checked ? "" : "invisible"}`} aria-hidden />}
              {item.label}
            </span>
            {item.hint && <span className="text-xs text-muted">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
