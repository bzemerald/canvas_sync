// Reordering short lists by dragging them: the sidebar, a course's tabs, the overview's cards.
// Pointer events rather than HTML5 drag and drop, which on Windows fights the webview's own
// handling of files dropped on the window, and leaves no say over what dragging looks like.
// A press only becomes a drag once the pointer has moved a few pixels, so clicks stay clicks.
import { useEffect, useRef, useState } from "react";

/** "y": a column; "x": a row; "grid": rows that wrap (before or after the nearest item);
 * "cards": anything (columns of cards): dropped on a card, an item takes its place. */
export type Axis = "x" | "y" | "grid" | "cards";

type Drag = { from: number; target: number };
/** Where a dragged item would land, relative to one item. */
export type Mark = "before" | "after" | "onto" | null; // target: where it would go, as an index between items (0..count)

export function useReorder(count: number, onMove: (from: number, to: number) => void, axis: Axis = "y") {
  const elements = useRef(new Map<number, HTMLElement>());
  const press = useRef<{ index: number; x: number; y: number; dragging: boolean } | null>(null);
  const current = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;

  useEffect(() => {
    const targetAt = (x: number, y: number): number => {
      const rects = Array.from({ length: count }, (_, i) => elements.current.get(i)?.getBoundingClientRect() ?? null);
      if (axis === "cards") {
        // The card under the pointer, else the nearest one.
        const under = rects.findIndex((r) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
        if (under >= 0) return under;
      }
      if (axis === "grid" || axis === "cards") {
        let best = -1;
        let bestDistance = Infinity;
        rects.forEach((r, i) => {
          if (!r) return;
          const d = (r.left + r.width / 2 - x) ** 2 + (r.top + r.height / 2 - y) ** 2;
          if (d < bestDistance) [best, bestDistance] = [i, d];
        });
        if (best < 0) return 0;
        if (axis === "cards") return best;
        const r = rects[best]!;
        return x > r.left + r.width / 2 ? best + 1 : best;
      }
      for (let i = 0; i < count; i++) {
        const r = rects[i];
        if (r && (axis === "x" ? x < r.left + r.width / 2 : y < r.top + r.height / 2)) return i;
      }
      return count;
    };
    const end = () => {
      press.current = null;
      current.current = null;
      setDrag(null);
      document.body.style.cursor = "";
    };
    const onPointerMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.dragging) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
        p.dragging = true;
        document.body.style.cursor = "grabbing";
      }
      const next = { from: p.index, target: targetAt(e.clientX, e.clientY) };
      if (next.target !== current.current?.target) {
        current.current = next;
        setDrag(next);
      }
    };
    const onPointerUp = () => {
      const p = press.current;
      const d = current.current;
      end();
      if (!p?.dragging) return;
      if (d) {
        const to = axis === "cards" ? d.target : d.target > d.from ? d.target - 1 : d.target;
        if (to !== d.from) moveRef.current(d.from, to);
      }
      // The click that ends a drag isn't a click on what was dragged.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && press.current?.dragging) end();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [count, axis]);

  /** On the element that is the item (what's measured to decide where it goes). */
  const ref = (index: number) => (el: HTMLElement | null) => {
    if (el) elements.current.set(index, el);
    else elements.current.delete(index);
  };
  /** On what you grab it by: the item itself, or a header or handle in it. */
  const handle = (index: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("input, textarea, select, [data-no-drag]")) return;
      press.current = { index, x: e.clientX, y: e.clientY, dragging: false };
    },
  });
  /** Where the dragged item would land, relative to item `index`; null when it wouldn't move. */
  const mark = (index: number): Mark => {
    if (axis === "cards") return drag && drag.target === index && index !== drag.from ? "onto" : null;
    if (!drag || drag.target === drag.from || drag.target === drag.from + 1) return null;
    if (drag.target === index) return "before";
    return drag.target === count && index === count - 1 ? "after" : null;
  };
  return {
    dragging: drag?.from ?? null,
    ref,
    handle,
    item: (index: number) => ({ ref: ref(index), ...handle(index) }),
    mark,
  };
}

/** The line that shows where a dragged item will land (in a `relative` item); for "onto", an
 * outline around the item whose place it takes. */
export function DropMark({ at, axis = "y" }: { at: Mark; axis?: Axis }) {
  if (!at) return null;
  if (at === "onto") return <span aria-hidden className="pointer-events-none absolute -inset-px z-10 rounded-[inherit] ring-2 ring-accent" />;
  const line = axis === "y"
    ? `inset-x-1 h-0.5 ${at === "before" ? "-top-px" : "-bottom-px"}`
    : `inset-y-1 w-0.5 ${at === "before" ? "-left-px" : "-right-px"}`;
  return <span aria-hidden className={`pointer-events-none absolute z-10 rounded-full bg-accent ${line}`} />;
}

/** `list` with the item at `from` moved to `to` (as the hook reports it). */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
