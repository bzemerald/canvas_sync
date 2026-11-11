// Things that change place glide there: the overview's cards, 工具与链接's links. After each
// render, whatever moved starts from where it was on screen (mid-glide, if it was gliding) and
// slides to its new place. One motion for everything: dragging, dropping, a card added or
// hidden, a card growing as its content comes in. And boxes that change size (useGlideHeight).
import { useLayoutEffect, useRef, useState } from "react";

/** How long things glide, and how: quick to start, easing in to where they go. */
export const GLIDE = "220ms cubic-bezier(0.2, 0, 0, 1)";
const MOTION = `transform ${GLIDE}`;
export const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

/** A box as tall as what's in it, gliding to each new height (a dialog going to its next step).
 * The content goes in `inner` (padding and all); `outer` is the box, given the height. */
export function useGlideHeight() {
  const [outer, setOuter] = useState<HTMLElement | null>(null);
  const [inner, setInner] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!outer || !inner) return;
    let first = true; // (opening: just that tall)
    let gliding = false;
    const tall = () => Math.ceil(inner.getBoundingClientRect().height);
    // Scrolls only when it can't be that tall (the window is shorter): a scroll bar coming and
    // going would narrow what's in it, and that would wrap it again to another height.
    const settle = () => {
      gliding = false;
      outer.style.overflowY = outer.clientHeight < tall() ? "auto" : "hidden";
    };
    const fit = () => {
      const height = `${tall() + outer.offsetHeight - outer.clientHeight}px`; // (and the box's border)
      if (outer.style.height === height) return gliding || settle();
      const glide = !first && !still();
      first = false;
      outer.style.transition = glide ? `height ${GLIDE}` : "none";
      outer.style.height = height;
      if (glide) {
        gliding = true;
        outer.style.overflowY = "hidden";
      } else settle();
    };
    const done = (e: TransitionEvent) => e.target === outer && settle();
    fit();
    const observer = new ResizeObserver(fit); // (the box too: the window got shorter, say)
    observer.observe(inner);
    observer.observe(outer);
    outer.addEventListener("transitionend", done);
    return () => {
      observer.disconnect();
      outer.removeEventListener("transitionend", done);
    };
  }, [outer, inner]);
  return [setOuter, setInner] as const;
}
