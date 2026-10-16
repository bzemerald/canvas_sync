// Dragging things around the app: a press becomes a drag once the pointer has moved a few
// pixels (so clicks stay clicks); while dragging, a copy of what's dragged follows the pointer,
// lists scroll when you get near their edge, and the click that ends a drag isn't a click.
// Pointer events rather than HTML5 drag and drop, which on Windows fights the webview's own
// handling of files dropped on the window, and leaves no say over what dragging looks like.

export interface DragHandlers {
  onStart?: () => void;
  /** true: it's over a place that takes it (置顶): the copy shrinks out of the way of what shows there. */
  onMove?: (x: number, y: number) => boolean | void;
  onDrop?: (x: number, y: number) => void; // released after a drag
  onCancel?: () => void; // Escape, or the window lost focus
}

const THRESHOLD = 5; // px before a press is a drag
const GHOST_MAX = 260; // px tall at most: a long card or term follows as its top part

/** Start watching a press on `source`; it becomes a drag if the pointer moves. */
export function trackDrag(e: React.PointerEvent, source: HTMLElement, h: DragHandlers): void {
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: Ghost | null = null;
  let scroller: AutoScroll | null = null;
  let last = { x: startX, y: startY };

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key);
    window.removeEventListener("blur", cancel);
    ghost?.remove();
    scroller?.stop();
    document.body.style.cursor = "";
  };
  const move = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      ghost = new Ghost(source, startX, startY);
      scroller = new AutoScroll(source, () => h.onMove?.(last.x, last.y));
      document.body.style.cursor = "grabbing";
      h.onStart?.();
    }
    scroller?.update(ev.clientX, ev.clientY);
    ghost.compact(!!h.onMove?.(ev.clientX, ev.clientY));
    ghost.move(ev.clientX, ev.clientY);
  };
  const up = (ev: PointerEvent) => {
    const dragged = !!ghost;
    finish();
    if (!dragged) return;
    h.onDrop?.(ev.clientX, ev.clientY);
    swallowNextClick();
  };
  const cancel = () => {
    const dragged = !!ghost;
    finish();
    if (dragged) h.onCancel?.();
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && ghost) {
      ev.preventDefault();
      cancel();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key);
  window.addEventListener("blur", cancel);
}

/** The click that ends a drag isn't a click on what was dragged. */
function swallowNextClick() {
  const swallow = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** A copy of what's dragged, under the pointer, held where it was grabbed. */
class Ghost {
  private el: HTMLElement;
  private dx: number;
  private dy: number;
  private grabbed: [number, number]; // dx, dy as grabbed
  private width: number;
  private small = false;

  constructor(source: HTMLElement, x: number, y: number) {
    const r = source.getBoundingClientRect();
    this.dx = x - r.left;
    this.dy = Math.min(y - r.top, GHOST_MAX - 12);
    this.grabbed = [this.dx, this.dy];
    this.width = r.width;
    const el = source.cloneNode(true) as HTMLElement;
    el.removeAttribute("id");
    el.setAttribute("aria-hidden", "true");
    const tall = r.height > GHOST_MAX;
    Object.assign(el.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: `${r.width}px`,
      height: `${Math.min(r.height, GHOST_MAX)}px`,
      margin: "0",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "1000",
      opacity: "0.95",
      background: "var(--panel)",
      color: "var(--fg)",
      borderRadius: "10px",
      boxShadow: "0 14px 36px rgba(0, 0, 0, 0.32), 0 0 0 1px var(--line)",
      maskImage: tall ? "linear-gradient(to bottom, black 70%, transparent)" : "",
      transition: "none",
      willChange: "transform",
    });
    document.body.appendChild(el);
    this.el = el;
    this.move(x, y);
  }

  private at(x: number, y: number) {
    return `translate(${x - this.dx}px, ${y - this.dy}px)`;
  }

  move(x: number, y: number) {
    this.el.style.transform = `${this.at(x, y)} scale(1.02)`; // a little lifted
  }

  /** Over 置顶: narrower, and below and right of the pointer, so the line where it'll go shows. */
  compact(on: boolean) {
    if (on === this.small) return;
    this.small = on;
    this.el.style.width = `${on ? Math.min(this.width, 220) : this.width}px`;
    this.el.style.opacity = on ? "0.85" : "0.95";
    [this.dx, this.dy] = on ? [-12, -10] : this.grabbed;
  }

  remove() {
    this.el.remove();
  }
}

/** Near the top or bottom edge of the list it's dragged in, the list scrolls. */
class AutoScroll {
  private box: HTMLElement | null;
  private speed = 0;
  private frame = 0;
  private onScroll: () => void;

  constructor(source: HTMLElement, onScroll: () => void) {
    this.onScroll = onScroll;
    let el: HTMLElement | null = source.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    this.box = el;
  }

  update(x: number, y: number) {
    if (!this.box) return;
    const r = this.box.getBoundingClientRect();
    const edge = 40;
    const beside = x < r.left || x > r.right; // (dragged over to the sidebar, say: leave the list be)
    this.speed = beside ? 0 : y < r.top + edge ? -Math.ceil((r.top + edge - y) / 4) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 4) : 0;
    if (this.speed && !this.frame) this.tick();
  }

  private tick = () => {
    if (!this.box || !this.speed) {
      this.frame = 0;
      return;
    }
    this.box.scrollTop += this.speed;
    this.onScroll();
    this.frame = requestAnimationFrame(this.tick);
  };

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.speed = 0;
  }
}
