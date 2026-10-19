// Where dragged things can be put: 置顶, a course's tabs, its overview, its 工具与链接. While
// something is dragged, the places that take it show it; the one under the pointer takes it on
// drop, at the place in its list the pointer points to. Of places inside one another (工具与链接
// is on the overview), the innermost takes it; neither takes what's dragged out of the other.
// Let go back where it came from (a row, on its own card: an element marked `data-home`), it
// isn't put anywhere.
import { useEffect, useRef, useState } from "react";
import { trackDrag } from "./drag";
import { dragOut } from "./dragOut";
import type { Shown } from "./things";

export type ZoneState = "idle" | "ready" | "over"; // ready: something it takes is being dragged

interface Zone {
  el: HTMLElement | null;
  accepts: (entry: Shown) => boolean;
  set: (state: ZoneState, x: number, y: number, entry: Shown | null) => void;
  drop: (entry: Shown, x: number, y: number) => void;
}
/** Which place a drag started in (its own place doesn't take it: that's a move within it). */
export type ZoneId = object;
const zones = new Set<Zone>();

const nested = (a: Zone, b: Zone) => !!a.el && !!b.el && (a.el.contains(b.el) || b.el.contains(a.el));
const area = (z: Zone) => {
  const r = z.el!.getBoundingClientRect(); // (which is innermost doesn't change as things move)
  return r.width * r.height;
};
/** Whether a place would take it at all (wherever the pointer is). */
const takes = (z: Zone, entry: Shown, from?: ZoneId) => z !== from && !(from && nested(z, from as Zone)) && z.accepts(entry);

// Where places (and the home of what's dragged) were when the drag began, and what they scroll
// in. A place makes room for what's dragged over it, which moves what's in it (工具与链接 on the
// overview, the card a row is dragged out of): judged by where things are drawn now, that would
// change which place it's over, which would undo the room, and so on.
interface Box {
  rect: DOMRect;
  scroller: HTMLElement | null;
  at: [number, number]; // its scroll then
}
let boxes: Map<Element, Box> | null = null;

function scroller(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) return p;
  }
  return null;
}

/** `el`'s box when the drag began, moved by however far it has scrolled since. */
function boxOf(el: Element): DOMRect {
  boxes ??= new Map();
  let b = boxes.get(el);
  if (!b) {
    const s = scroller(el);
    b = { rect: el.getBoundingClientRect(), scroller: s, at: [s?.scrollLeft ?? 0, s?.scrollTop ?? 0] };
    boxes.set(el, b);
  }
  const [dx, dy] = [(b.scroller?.scrollLeft ?? 0) - b.at[0], (b.scroller?.scrollTop ?? 0) - b.at[1]];
  return new DOMRect(b.rect.x - dx, b.rect.y - dy, b.rect.width, b.rect.height);
}

const inside = (el: Element | null | undefined, x: number, y: number) => {
  if (!el) return false;
  const r = boxOf(el);
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};

/** Every place's box, now (the first time something is dragged over places). */
function measureAll() {
  boxes = new Map();
  zones.forEach((z) => z.el && boxOf(z.el));
}

function under(x: number, y: number, entry: Shown, from?: ZoneId, source?: HTMLElement): Zone | null {
  if (inside(source?.closest("[data-home]"), x, y)) return null;
  const here = [...zones].filter((z) => inside(z.el, x, y));
  for (const z of here.sort((a, b) => area(a) - area(b))) {
    if (z === from) return null; // (moved within its own place)
    if (takes(z, entry, from)) return z;
  }
  return null;
}

export const dropZones = {
  /** The pointer moved while dragging something (a thing or not): light up the places that take
   * it. True when it's over one. */
  update(x: number, y: number, entry: Shown | null, from?: ZoneId, source?: HTMLElement): boolean {
    if (!boxes) measureAll();
    const over = entry ? under(x, y, entry, from, source) : null;
    zones.forEach((z) => z.set(!entry || !takes(z, entry, from) ? "idle" : z === over ? "over" : "ready", x, y, entry));
    return !!over;
  },
  /** Dropped: taken if it was over a place that takes it. */
  drop(x: number, y: number, entry: Shown | null, from?: ZoneId, source?: HTMLElement): boolean {
    const z = entry ? under(x, y, entry, from, source) : null;
    dropZones.end();
    if (!z || !entry) return false;
    z.drop(entry, x, y);
    return true;
  },
  end() {
    boxes = null;
    zones.forEach((z) => z.set("idle", 0, 0, null));
  },
};

/** Makes an element a place things can be dropped on. `slotAt` says where in its list a drop at
 * (x, y) would go; while something is over it, `slot` is that place and `entry` what it is. `id`:
 * for useReorder, so the list's own items moving in it aren't drops on it. */
export function useDropZone(
  onDrop: (entry: Shown, slot: number) => void,
  slotAt: (x: number, y: number) => number = () => 0,
  accepts: (entry: Shown) => boolean = () => true,
) {
  const [state, setState] = useState<ZoneState>("idle");
  const [slot, setSlot] = useState(0);
  const [over, setOver] = useState<Shown | null>(null);
  const slotRef = useRef(slotAt);
  slotRef.current = slotAt;
  const zone = useRef<Zone>({ el: null, accepts, set: () => {}, drop: () => {} });
  zone.current.accepts = accepts;
  zone.current.set = (s, x, y, entry) => {
    setState(s);
    setOver(s === "over" ? entry : null);
    if (s === "over") setSlot(slotRef.current(x, y)); // (a re-render only when it changes)
  };
  zone.current.drop = (entry, x, y) => onDrop(entry, slotRef.current(x, y));
  useEffect(() => {
    const z = zone.current;
    zones.add(z);
    return () => void zones.delete(z);
  }, []);
  return { ref: (el: HTMLElement | null) => void (zone.current.el = el), state, slot, entry: over, id: zone.current as ZoneId };
}

/** Drag something only to put it somewhere (a file, an announcement, a row in a card): press on
 * `el`. Out of the window, files go to other apps: `files` (in the sync folder) if given, what's
 * selected with it. */
export function dragToPlace(e: React.PointerEvent, el: HTMLElement, entry: Shown, files?: string[]) {
  if (e.button !== 0) return;
  trackDrag(e, el, {
    onMove: (x, y) => (dropZones.update(x, y, entry, undefined, el) ? "zone" : undefined),
    onDrop: (x, y) => void dropZones.drop(x, y, entry, undefined, el),
    onCancel: () => dropZones.end(),
    out: dragOut(entry, undefined, files),
  });
}
