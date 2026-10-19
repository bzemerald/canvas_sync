// Reordering short lists by dragging: the sidebar, a course's tabs, the overview's cards, the
// rows of 工具与链接. What's dragged follows the pointer (see drag.ts); in a row or a column the
// others slide aside to open a gap where it will land; among cards, the list is drawn as it
// would be if let go now (`preview`), the dragged card's place a slot, and the cards glide to make
// room (flip.ts). Let go, the copy lands in its place. What's in a list is a thing, so it can be
// dropped in another place too (see dropZones.ts); what you put in a list (not the list's own)
// can be dragged off it to take it away.
import { useRef, useState } from "react";
import { trackDrag, type DragOver } from "./drag";
import { dragOut } from "./dragOut";
import { dropZones, type ZoneId } from "./dropZones";
import type { Shown } from "./things";

/** "y": a column; "x": a row; "cards": anything (columns of cards, wrapping rows): the list
 * reflows around the dragged item as it goes. */
export type Axis = "x" | "y" | "cards";

export interface ReorderOptions {
  thing?: (index: number) => Shown | null; // what it is, to drop in another place
  zone?: ZoneId; // the place this list is: its own items moving in it aren't drops on it
  remove?: (index: number) => (() => void) | null; // dragged well off the list and let go: this takes it away
  /** Cards: where in the list it goes (as `to`), with the pointer at (x, y). It mustn't depend on
   * where things are drawn while dragging (they move to make room: that would feed back). Without
   * it: the card it's over, or nearest, where they were when the drag began. */
  slotAt?: (x: number, y: number, from: number) => number;
}

const OFF = 28; // px past the list's edges: dragged off it

export function useReorder(count: number, onMove: (from: number, to: number) => void, axis: Axis = "y", options: ReorderOptions = {}) {
  const elements = useRef(new Map<number, HTMLElement>());
  const [drag, setDrag] = useState<{ from: number; target: number } | null>(null);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const opts = useRef(options);
  opts.current = options;

  const handle = (index: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("input, textarea, select, [data-no-drag]")) return;
      const source = elements.current.get(index);
      if (!source) return;
      const target = opts.current.thing?.(index) ?? null;
      const zone = opts.current.zone;
      const remove = opts.current.remove?.(index) ?? null;
      let removing = false;
      const shifts = new Map<number, number>(); // px each item is moved aside, now
      let size = 0; // the gap to open: the dragged item's length, with the space after it
      let at = index; // insertion point (0..count) for rows/columns; the card to take for cards

      // Where the items were when the drag began (sliding them aside doesn't move their landing
      // spots, and they're mid-animation half the time), kept in step with scrolling.
      const measure = () => Array.from({ length: count }, (_, i) => elements.current.get(i)?.getBoundingClientRect() ?? null);
      let base: (DOMRect | null)[] = [];
      let list: DOMRect | null = null; // the list's box when the drag began, for "off it"
      const box = scrollParent(source);
      const scrolled = () => ({ x: box?.scrollLeft ?? 0, y: box?.scrollTop ?? 0 });
      let from0 = scrolled();
      const rects = () => {
        const now = scrolled();
        const [dx, dy] = [now.x - from0.x, now.y - from0.y];
        return base.map((r) => r && new DOMRect(r.x - dx, r.y - dy, r.width, r.height));
      };
      const landing = (x: number, y: number): number => {
        if (axis === "cards" && opts.current.slotAt) return opts.current.slotAt(x, y, index);
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
        if (axis !== "cards") {
          // Straight back to no shift: the list is about to be drawn in its new order.
          elements.current.forEach((el) => {
            if (el === source) return; // (shown when the copy has landed in its place)
            el.style.transition = "none";
            el.style.transform = "";
          });
        }
        shifts.clear();
        setDrag(null);
      };
      // The copy has landed: it's the item again.
      const settled = () => {
        delete source.dataset.placeholder;
        source.style.transition = "none";
        source.style.transform = "";
        source.style.opacity = "";
      };

      trackDrag(e, source, {
        onStart: () => {
          base = measure();
          list = source.parentElement?.getBoundingClientRect() ?? null;
          from0 = scrolled();
          const rs = rects();
          const me = rs[index];
          const next = rs[index + 1] ?? rs[index - 1];
          if (me) {
            const gap = next ? (axis === "x" ? Math.abs(next.left - me.left) - me.width : Math.abs(next.top - me.top) - me.height) : 0;
            size = (axis === "x" ? me.width : me.height) + Math.max(0, gap);
          }
          // The copy under the pointer stands in for it; its place shows as a gap (cards: a slot).
          if (axis === "cards") source.dataset.placeholder = "";
          else {
            source.style.transition = "opacity 120ms ease";
            source.style.opacity = "0";
          }
          setDrag({ from: index, target: index });
        },
        onMove: (x, y): DragOver => {
          const elsewhere = dropZones.update(x, y, target, zone);
          const off = !elsewhere && !!remove && !!list &&
            (x < list.left - OFF || x > list.right + OFF || y < list.top - OFF || y > list.bottom + OFF);
          if (elsewhere || off) {
            // Over another place: it'll be put there and stay here, so its gap stays open. Off the
            // list: it'll be taken away, so the ones after it close the gap.
            removing = off;
            at = index;
            slide(off && axis !== "cards" ? count : index);
            setDrag({ from: index, target: index });
            return elsewhere ? "zone" : "remove";
          }
          const next = landing(x, y);
          if (next === at && !removing) return;
          removing = false; // (back over the list)
          at = next;
          slide(axis === "cards" ? index : at);
          setDrag({ from: index, target: at });
        },
        onDrop: (x, y) => {
          reset();
          if (dropZones.drop(x, y, target, zone)) return settled(); // (it stays here too)
          if (removing && remove) return remove();
          const to = axis === "cards" ? at : at > index ? at - 1 : at;
          if (to !== index || axis === "cards") moveRef.current(index, to); // (cards: maybe to another column, in the same place)
          return source; // (the same element, in its new place once the list is drawn again)
        },
        onCancel: () => {
          reset();
          dropZones.end();
          return source;
        },
        onSettled: settled,
        out: target ? dragOut(target, zone) : undefined, // (files, out of the window: to other apps)
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
    /** For cards: `list` as it would be if the dragged one were let go now. */
    preview: <T,>(list: T[]): T[] => (axis === "cards" && drag ? moved(list, drag.from, drag.target) : list),
  };
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) return p;
  }
  return null;
}

/** `list` with the item at `from` moved to `to` (as the hook reports it). */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
