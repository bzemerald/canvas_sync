// Reordering short lists by dragging: the sidebar, a course's tabs, the overview's cards.
// What's dragged follows the pointer (see drag.ts); in a row or a column the others slide
// aside to open a gap where it will land; among cards, the one it will take the place of is
// outlined. Things that can be pinned can also be dropped on 置顶 (see pinZone.ts).
import { useRef, useState } from "react";
import type { PinTarget } from "./api";
import { trackDrag } from "./drag";
import { pinZones } from "./pinZone";

/** "y": a column; "x": a row; "cards": anything (columns of cards): dropped on a card, an item
 * takes its place. */
export type Axis = "x" | "y" | "cards";

/** Where a dragged item would land, relative to one item (only "onto", for cards). */
export type Mark = "onto" | null;

export function useReorder(
  count: number,
  onMove: (from: number, to: number) => void,
  axis: Axis = "y",
  pin?: (index: number) => PinTarget | null, // what dropping it on 置顶 pins
) {
  const elements = useRef(new Map<number, HTMLElement>());
  const [drag, setDrag] = useState<{ from: number; target: number } | null>(null);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const pinRef = useRef(pin);
  pinRef.current = pin;

  const handle = (index: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("input, textarea, select, [data-no-drag]")) return;
      const source = elements.current.get(index);
      if (!source) return;
      const target = pinRef.current?.(index) ?? null;
      const shifts = new Map<number, number>(); // px each item is moved aside, now
      let size = 0; // the gap to open: the dragged item's length, with the space after it
      let at = index; // insertion point (0..count) for rows/columns; the card to take for cards
      let before = ""; // the item's own transition (cards slide to new places), put back after

      // Where the items were when the drag began (sliding them aside doesn't move their landing
      // spots, and they're mid-animation half the time), kept in step with scrolling.
      const measure = () => Array.from({ length: count }, (_, i) => elements.current.get(i)?.getBoundingClientRect() ?? null);
      let base: (DOMRect | null)[] = [];
      const box = scrollParent(source);
      const scrolled = () => ({ x: box?.scrollLeft ?? 0, y: box?.scrollTop ?? 0 });
      let from0 = scrolled();
      const rects = () => {
        const now = scrolled();
        const [dx, dy] = [now.x - from0.x, now.y - from0.y];
        return base.map((r) => r && new DOMRect(r.x - dx, r.y - dy, r.width, r.height));
      };
      const landing = (x: number, y: number): number => {
        const rs = rects();
        if (axis === "cards") {
          const hit = rs.findIndex((r) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
          if (hit >= 0) return hit;
          let best = index;
          let bestDistance = Infinity;
          rs.forEach((r, i) => {
            if (!r) return;
            const d = (r.left + r.width / 2 - x) ** 2 + (r.top + r.height / 2 - y) ** 2;
            if (d < bestDistance) [best, bestDistance] = [i, d];
          });
          return best;
        }
        for (let i = 0; i < count; i++) {
          const r = rs[i];
          if (r && (axis === "x" ? x < r.left + r.width / 2 : y < r.top + r.height / 2)) return i;
        }
        return count;
      };
      // Rows and columns: the items between where it was and where it goes slide over.
      const slide = (to: number) => {
        if (axis === "cards") return;
        for (let i = 0; i < count; i++) {
          const el = elements.current.get(i);
          if (!el || i === index) continue;
          const d = index < to && i > index && i < to ? -size : to <= i && i < index ? size : 0;
          if ((shifts.get(i) ?? 0) === d) continue;
          shifts.set(i, d);
          el.style.transition = "transform 160ms ease";
          el.style.transform = d ? (axis === "x" ? `translateX(${d}px)` : `translateY(${d}px)`) : "";
        }
      };
      const reset = () => {
        if (axis === "cards") {
          // It lands where it was dropped, not sliding over from where it was; then it's as before.
          source.style.opacity = "";
          source.style.transition = "none";
          requestAnimationFrame(() => requestAnimationFrame(() => (source.style.transition = before)));
        } else {
          // Straight back to no shift: the list is about to be drawn in its new order.
          elements.current.forEach((el) => {
            el.style.transition = "none";
            el.style.transform = "";
            el.style.opacity = "";
          });
        }
        shifts.clear();
        setDrag(null);
      };

      trackDrag(e, source, {
        onStart: () => {
          base = measure();
          from0 = scrolled();
          const rs = rects();
          const me = rs[index];
          const next = rs[index + 1] ?? rs[index - 1];
          if (me) {
            const gap = next ? (axis === "x" ? Math.abs(next.left - me.left) - me.width : Math.abs(next.top - me.top) - me.height) : 0;
            size = (axis === "x" ? me.width : me.height) + Math.max(0, gap);
          }
          // The copy under the pointer stands in for it; its place shows as a gap.
          before = source.style.transition;
          source.style.transition = axis === "cards" && before && before !== "none" ? `${before}, opacity 120ms ease` : "opacity 120ms ease";
          source.style.opacity = axis === "cards" ? "0.35" : "0";
          setDrag({ from: index, target: index });
        },
        onMove: (x, y) => {
          if (pinZones.update(x, y, !!target)) {
            // Over 置顶: it'll be pinned, not moved; the list closes up again.
            at = index;
            slide(index);
            setDrag({ from: index, target: index });
            return;
          }
          const next = landing(x, y);
          if (next === at) return;
          at = next;
          slide(axis === "cards" ? index : at);
          setDrag({ from: index, target: at });
        },
        onDrop: (x, y) => {
          reset();
          if (pinZones.drop(x, y, target)) return;
          const to = axis === "cards" ? at : at > index ? at - 1 : at;
          if (to !== index) moveRef.current(index, to);
        },
        onCancel: () => {
          reset();
          pinZones.end();
        },
      });
    },
  });

  /** On the element that is the item (what moves, and what's measured). */
  const ref = (index: number) => (el: HTMLElement | null) => {
    if (el) elements.current.set(index, el);
    else elements.current.delete(index);
  };
  return {
    dragging: drag?.from ?? null,
    ref,
    /** On what you grab it by: the item itself, or a header in it. */
    handle,
    item: (index: number) => ({ ref: ref(index), ...handle(index) }),
    /** For cards: outline the one a dragged card would take the place of. */
    mark: (index: number): Mark => (axis === "cards" && drag && drag.target === index && index !== drag.from ? "onto" : null),
  };
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) return p;
  }
  return null;
}

/** The outline around the card a dragged one will take the place of (in a `relative` item). */
export function DropMark({ at }: { at: Mark }) {
  if (!at) return null;
  return <span aria-hidden className="pointer-events-none absolute -inset-px z-10 rounded-[inherit] ring-2 ring-accent" />;
}

/** `list` with the item at `from` moved to `to` (as the hook reports it). */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
