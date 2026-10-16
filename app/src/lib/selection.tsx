// Selecting items in a list or grid the way file managers do: click selects one,
// ⌘/Ctrl-click toggles, Shift-click selects a range, dragging on empty space draws a box.
import { useCallback, useEffect, useRef, useState } from "react";
import { primary } from "./keys";

export interface Selection {
  selected: Set<string>;
  cursor: string | null; // the item the keyboard is on
  has: (key: string) => boolean;
  click: (key: string, e: React.MouseEvent) => void;
  only: (key: string) => void;
  moveTo: (key: string, extend: boolean) => void;
  all: () => void;
  clear: () => void;
  replace: (keys: Iterable<string>) => void;
}

export function useSelection(keys: string[]): Selection {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const order = useRef(keys);
  order.current = keys;

  // Forget items that are no longer shown.
  const signature = keys.join("\u0000");
  useEffect(() => {
    const present = new Set(order.current);
    setSelected((s) => {
      const kept = new Set([...s].filter((k) => present.has(k)));
      return kept.size === s.size ? s : kept;
    });
    setCursor((c) => (c && present.has(c) ? c : null));
  }, [signature]);

  const range = (from: string, to: string) => {
    const ks = order.current;
    let i = ks.indexOf(from);
    let j = ks.indexOf(to);
    if (i < 0) i = j;
    if (i > j) [i, j] = [j, i];
    return ks.slice(i, j + 1);
  };

  const only = useCallback((k: string) => {
    setSelected(new Set([k]));
    setCursor(k);
    anchor.current = k;
  }, []);

  const click = (k: string, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const r = range(anchor.current, k);
      setSelected((prev) => (primary(e) ? new Set([...prev, ...r]) : new Set(r)));
      setCursor(k);
    } else if (primary(e)) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(k)) next.add(k);
        return next;
      });
      setCursor(k);
      anchor.current = k;
    } else {
      only(k);
    }
  };

  const moveTo = (k: string, extend: boolean) => {
    if (extend && anchor.current) {
      setSelected(new Set(range(anchor.current, k)));
      setCursor(k);
    } else {
      only(k);
    }
  };

  return {
    selected,
    cursor,
    has: (k) => selected.has(k),
    click,
    only,
    moveTo,
    all: () => setSelected(new Set(order.current)),
    clear: () => setSelected(new Set()),
    replace: (ks) => setSelected(new Set(ks)),
  };
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Drag on empty space to select everything the box touches. Items are the elements
 * inside `container` with a `data-key` attribute. Returns the box to draw (in the
 * container's scrolled coordinates) and the handler for the container's onMouseDown.
 */
export function useMarquee(container: React.RefObject<HTMLElement | null>, sel: Selection) {
  const [box, setBox] = useState<Box | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    const el = container.current;
    if (!el || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-key], input, button, a")) return; // items handle their own clicks
    e.preventDefault(); // no text selection; but that also skips focusing, so do it ourselves
    (el.closest<HTMLElement>("[tabindex]") ?? el).focus();
    const additive = e.shiftKey || primary(e);
    const base = additive ? new Set(sel.selected) : new Set<string>();
    const at = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      return { x: x - r.left + el.scrollLeft, y: y - r.top + el.scrollTop };
    };
    const start = at(e.clientX, e.clientY);
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const r = el.getBoundingClientRect();
      if (ev.clientY > r.bottom - 24) el.scrollTop += 16; // keep going past the edge
      else if (ev.clientY < r.top + 24) el.scrollTop -= 16;
      const now = at(ev.clientX, ev.clientY);
      if (!moved && Math.hypot(now.x - start.x, now.y - start.y) < 4) return;
      moved = true;
      const b = {
        left: Math.min(start.x, now.x),
        top: Math.min(start.y, now.y),
        width: Math.abs(now.x - start.x),
        height: Math.abs(now.y - start.y),
      };
      setBox(b);
      const hit = new Set(base);
      el.querySelectorAll<HTMLElement>("[data-key]").forEach((item) => {
        const ir = item.getBoundingClientRect();
        const p = at(ir.left, ir.top);
        if (p.x < b.left + b.width && p.x + ir.width > b.left && p.y < b.top + b.height && p.y + ir.height > b.top) {
          hit.add(item.dataset.key!);
        }
      });
      sel.replace(hit);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setBox(null);
      if (!moved && !additive) sel.clear(); // a plain click on empty space deselects
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return { box, onMouseDown };
}

export function MarqueeBox({ box }: { box: Box | null }) {
  if (!box) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 rounded-sm border border-accent bg-accent/10"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    />
  );
}
