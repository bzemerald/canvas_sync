// Where dragged things can be pinned: the sidebar's 置顶, and a course's tabs. While something
// pinnable is dragged, zones that take it show it; the one under the pointer takes it on drop,
// at the place in its list the pointer points to.
import { useEffect, useRef, useState } from "react";
import type { PinTarget } from "./api";
import { trackDrag } from "./drag";

export type ZoneState = "idle" | "ready" | "over"; // ready: something it takes is being dragged

interface Zone {
  el: HTMLElement | null;
  accepts: (target: PinTarget) => boolean;
  set: (state: ZoneState, x: number, y: number) => void;
  drop: (target: PinTarget, x: number, y: number) => void;
}
/** Which zone a drag started in (its own zone doesn't take it: that's a move within it). */
export type ZoneId = object;
const zones = new Set<Zone>();

function under(x: number, y: number, target: PinTarget, from?: ZoneId): Zone | null {
  for (const z of zones) {
    if (z === from || !z.accepts(target)) continue;
    const r = z.el?.getBoundingClientRect();
    if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return z;
  }
  return null;
}

export const pinZones = {
  /** The pointer moved while dragging something (pinnable or not): light up the zones that take
   * it. True when it's over one. */
  update(x: number, y: number, target: PinTarget | null, from?: ZoneId): boolean {
    const over = target ? under(x, y, target, from) : null;
    zones.forEach((z) => z.set(!target || z === from || !z.accepts(target) ? "idle" : z === over ? "over" : "ready", x, y));
    return !!over;
  },
  /** Dropped: taken if it was over a zone that takes it. */
  drop(x: number, y: number, target: PinTarget | null, from?: ZoneId): boolean {
    const z = target ? under(x, y, target, from) : null;
    pinZones.end();
    if (!z || !target) return false;
    z.drop(target, x, y);
    return true;
  },
  end() {
    zones.forEach((z) => z.set("idle", 0, 0));
  },
};

/** Makes an element a place to drop things. `slotAt` says where in its list a drop at (x, y)
 * would go; while something is over the zone, `slot` is that place. `id`: for useReorder, so the
 * list's own items aren't offered to it. */
export function usePinZone(
  onDrop: (target: PinTarget, slot: number) => void,
  slotAt: (x: number, y: number) => number = () => 0,
  accepts: (target: PinTarget) => boolean = () => true,
) {
  const [state, setState] = useState<ZoneState>("idle");
  const [slot, setSlot] = useState(0);
  const slotRef = useRef(slotAt);
  slotRef.current = slotAt;
  const zone = useRef<Zone>({ el: null, accepts, set: () => {}, drop: () => {} });
  zone.current.accepts = accepts;
  zone.current.set = (s, x, y) => {
    setState(s);
    if (s === "over") setSlot(slotRef.current(x, y)); // (a re-render only when it changes)
  };
  zone.current.drop = (target, x, y) => onDrop(target, slotRef.current(x, y));
  useEffect(() => {
    const z = zone.current;
    zones.add(z);
    return () => void zones.delete(z);
  }, []);
  return { ref: (el: HTMLElement | null) => void (zone.current.el = el), state, slot, id: zone.current as ZoneId };
}

/** Drag something only to pin it (a file, an announcement, a tool...): press on `el`. */
export function dragToPin(e: React.PointerEvent, el: HTMLElement, target: PinTarget) {
  if (e.button !== 0) return;
  trackDrag(e, el, {
    onMove: (x, y) => (pinZones.update(x, y, target) ? "zone" : undefined),
    onDrop: (x, y) => void pinZones.drop(x, y, target),
    onCancel: () => pinZones.end(),
  });
}
