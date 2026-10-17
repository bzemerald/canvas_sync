// Things that change place glide there: the overview's cards, 工具与链接's links. After each
// render, whatever moved starts from where it was on screen (mid-glide, if it was gliding) and
// slides to its new place. One motion for everything: dragging, dropping, a card added or
// hidden, a card growing as its content comes in.
import { useLayoutEffect, useRef } from "react";

const MOTION = "transform 220ms cubic-bezier(0.2, 0, 0, 1)";
const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** For the children of `container` marked `data-flip="<key>"`. `enabled` false: they just go
 * there (the first layout, before which everything is at the top). */
export function useFlip(container: HTMLElement | null, enabled: boolean) {
  const last = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    if (!container) return;
    const seen = new Map<string, { x: number; y: number }>();
    const moving: HTMLElement[] = [];
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(":scope > [data-flip]"))) {
      const key = el.dataset.flip!;
      const now = { x: el.offsetLeft, y: el.offsetTop }; // (where it's laid out: not moved by transforms or scrolling)
      seen.set(key, now);
      const was = last.current.get(key);
      if (!enabled || still() || !was || (was.x === now.x && was.y === now.y)) continue;
      // Where it shows now: where it was laid out, plus how far along a glide it was.
      const m = new DOMMatrix(getComputedStyle(el).transform);
      el.style.transition = "none";
      el.style.transform = `translate(${was.x + m.m41 - now.x}px, ${was.y + m.m42 - now.y}px)`;
      moving.push(el);
    }
    last.current = seen;
    if (!moving.length) return;
    void container.offsetHeight; // (the start, drawn before the glide)
    for (const el of moving) {
      el.style.transition = MOTION;
      el.style.transform = "";
    }
  });
}
