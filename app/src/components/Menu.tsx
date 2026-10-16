import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | "separator";

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** A context menu at the mouse. Closes on click elsewhere, Escape, scroll or blur. */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
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
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left hover:bg-selected disabled:opacity-40 disabled:hover:bg-transparent ${item.danger ? "text-danger" : "text-fg"}`}
          >
            {item.label}
            {item.hint && <span className="text-xs text-muted">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
