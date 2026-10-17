// Dragging things around the app: a press becomes a drag once the pointer has moved a few
// pixels (so clicks stay clicks); while dragging, a copy of what's dragged follows the pointer,
// lists scroll when you get near their edge, and the click that ends a drag isn't a click.
// Pointer events rather than HTML5 drag and drop, which on Windows fights the webview's own
// handling of files dropped on the window, and leaves no say over what dragging looks like.
// Where the copy would be cut off by the window's edge, a window of its own carries it on.
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emitTo } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";

/** Where a drag is, for how the copy looks: over a place that takes it (置顶, a course's tabs):
 * it shrinks out of the way of what shows there; dragged off its list to take it away: faded,
 * with a minus. */
export type DragOver = "zone" | "remove" | void;

/** Where the copy goes when it's let go: into this element (it lands there, then the element
 * shows instead), or nowhere (it fades out: put in another place, taken away). */
export type Landing = HTMLElement | null | void;

export interface DragHandlers {
  onStart?: () => void;
  onMove?: (x: number, y: number) => DragOver;
  onDrop?: (x: number, y: number) => Landing; // released after a drag
  onCancel?: () => Landing; // Escape, or the window lost focus
  onSettled?: () => void; // the copy has landed (or faded): show what it stood in for
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
    scroller?.stop();
    document.body.style.cursor = "";
    document.documentElement.classList.remove("dragging");
  };
  const move = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      ghost = new Ghost(source, startX, startY);
      scroller = new AutoScroll(source, () => h.onMove?.(last.x, last.y));
      document.body.style.cursor = "grabbing";
      // Not selecting text on the way (the press was the start of a selection too).
      document.documentElement.classList.add("dragging");
      window.getSelection()?.removeAllRanges();
      h.onStart?.();
    }
    scroller?.update(ev.clientX, ev.clientY);
    const over = h.onMove?.(ev.clientX, ev.clientY);
    ghost.compact(over === "zone");
    ghost.removing(over === "remove");
    ghost.move(ev.clientX, ev.clientY, ev.screenX, ev.screenY);
  };
  const land = (to: Landing) => {
    const g = ghost!;
    ghost = null;
    void g.land(to).then(() => h.onSettled?.());
  };
  const up = (ev: PointerEvent) => {
    finish();
    if (!ghost) return;
    land(h.onDrop?.(ev.clientX, ev.clientY));
    swallowNextClick();
  };
  const cancel = () => {
    finish();
    if (ghost) land(h.onCancel?.());
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
  private source: HTMLElement;
  private dx: number;
  private dy: number;
  private grabbed: [number, number]; // dx, dy as grabbed
  private width: number;
  private small = false;
  private badge: HTMLElement | null = null; // the minus: let go, and it's taken away
  private follower: Follower;
  private following = false; // cut off by the window's edge: the follower carries it

  constructor(source: HTMLElement, x: number, y: number) {
    this.source = source;
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
    this.follower = new Follower((shown) => void (this.el.style.visibility = shown && this.following ? "hidden" : ""));
    this.move(x, y);
    this.sync();
  }

  private at(x: number, y: number) {
    return `translate(${x - this.dx}px, ${y - this.dy}px)`;
  }

  /** At (x, y) in the window; (sx, sy) on the screen. Where the window's edge would cut the copy
   * off (dragging a pin out of the sidebar, say), the follower carries it there. */
  move(x: number, y: number, sx?: number, sy?: number) {
    this.el.style.transform = `${this.at(x, y)} scale(1.02)`; // a little lifted
    if (sx === undefined || sy === undefined) return;
    const [left, top] = [x - this.dx, y - this.dy];
    const [w, h] = [parseFloat(this.el.style.width), parseFloat(this.el.style.height)];
    if (left < 0 || top < 0 || left + w > window.innerWidth || top + h > window.innerHeight) {
      this.following = true;
      this.follower.show(sx - this.dx, sy - this.dy);
    } else if (this.following) {
      this.following = false;
      this.el.style.visibility = "";
      this.follower.hide();
    }
  }

  /** The follower gets the copy as it looks now. */
  private sync() {
    const copy = this.el.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, { position: "relative", left: "0px", top: "0px", transform: "none", visibility: "visible", zIndex: "auto" });
    inlineImages(this.source, copy);
    this.follower.content(copy.outerHTML, parseFloat(this.el.style.width), parseFloat(this.el.style.height));
  }

  /** Over 置顶: narrower, and below and right of the pointer, so the line where it'll go shows. */
  compact(on: boolean) {
    if (on === this.small) return;
    this.small = on;
    this.el.style.width = `${on ? Math.min(this.width, 220) : this.width}px`;
    this.el.style.opacity = on ? "0.85" : "0.95";
    [this.dx, this.dy] = on ? [-12, -10] : this.grabbed;
    this.sync();
  }

  /** Off its list: let go and it's taken away (unpinned, removed). */
  removing(on: boolean) {
    if (on === !!this.badge) return;
    if (on) {
      const b = document.createElement("span");
      b.textContent = "−";
      Object.assign(b.style, {
        position: "absolute", top: "4px", right: "4px", width: "18px", height: "18px", borderRadius: "9px",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", lineHeight: "1",
        background: "#ff3b30", color: "#fff", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)", // (red, as macOS shows taking away)
      });
      // What's in it fades; the minus doesn't (the copy's own opacity would take it along).
      for (const c of Array.from(this.el.children) as HTMLElement[]) c.style.opacity = "0.45";
      this.el.appendChild(b);
      this.badge = b;
    } else {
      this.badge?.remove();
      this.badge = null;
      for (const c of Array.from(this.el.children) as HTMLElement[]) c.style.opacity = "";
    }
    this.sync();
  }

  /** Let go: it glides into `to` and settles there (or fades out where it is); then it's gone.
   * (Carried by the follower, past the window's edge: back in the page for that, gliding in.) */
  async land(to: Landing) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return this.remove();
    if (this.following) {
      if (!to?.isConnected) return this.remove(); // (let go outside the window: nothing to glide into)
      this.following = false;
      this.el.style.visibility = "";
      this.follower.hide();
    }
    await new Promise(requestAnimationFrame); // (the page has its new order by now)
    const r = to?.isConnected ? to.getBoundingClientRect() : null;
    const s = this.el.style;
    s.transition = `transform ${LAND}ms cubic-bezier(0.2, 0, 0, 1), width ${LAND}ms, height ${LAND}ms, box-shadow ${LAND}ms, opacity ${LAND}ms`;
    if (r) {
      Object.assign(s, { transform: `translate(${r.left}px, ${r.top}px)`, width: `${r.width}px`, height: `${Math.min(r.height, GHOST_MAX)}px`, boxShadow: "0 0 0 1px var(--line)", opacity: "1" });
    } else {
      Object.assign(s, { transform: `${s.transform.replace(/ scale\([^)]*\)/, "")} scale(0.92)`, opacity: "0" });
    }
    await new Promise((done) => setTimeout(done, LAND));
    this.remove();
  }

  remove() {
    this.follower.hide();
    this.el.remove();
  }
}

const LAND = 200; // ms: the copy gliding into place when let go

/** Images the follower window can't load (blob: links belong to this page), as data. */
function inlineImages(from: HTMLElement, to: HTMLElement) {
  const sources = from.querySelectorAll("img");
  to.querySelectorAll("img").forEach((img, i) => {
    const src = sources[i];
    if (!src?.src.startsWith("blob:") || !src.complete || !src.naturalWidth) return;
    try {
      const c = document.createElement("canvas");
      [c.width, c.height] = [src.naturalWidth, src.naturalHeight];
      c.getContext("2d")!.drawImage(src, 0, 0);
      img.src = c.toDataURL();
    } catch {
      img.removeAttribute("src");
    }
  });
}

const PAD = 28; // room around the copy in the follower window, for its shadow
let followerWindow: Promise<Window | null> | null = null;
const followerWin = () => (followerWindow ??= Window.getByLabel("ghost").catch(() => null));

/** The window (see components/DragGhost.tsx) that carries the copy once it reaches the main
 * window's edge: transparent, letting the pointer through, never taking the focus (which would
 * end the drag). It shows the same copy at the same place on the screen. Moves are sent one at
 * a time, the latest one next. */
class Follower {
  private want = false; // should it be showing
  private shown = false;
  private busy = false;
  private target: [number, number] | null = null; // where its top left goes, on the screen
  private placed: [number, number] | null = null;
  private onShown: (shown: boolean) => void;

  constructor(onShown: (shown: boolean) => void) {
    this.onShown = onShown;
  }

  /** What it shows: the copy's HTML, `w` by `h`. */
  content(html: string, w: number, h: number) {
    void emitTo("ghost", "drag-ghost", { html: `<div style="padding: ${PAD}px">${html}</div>` }).catch(() => {});
    void followerWin().then((win) => win?.setSize(new LogicalSize(w + 2 * PAD, h + 2 * PAD))).catch(() => {});
  }

  /** The copy's top left at (x, y) on the screen. */
  show(x: number, y: number) {
    this.want = true;
    this.target = [x - PAD, y - PAD];
    if (!this.busy) void this.run();
  }

  hide() {
    this.want = false;
    if (!this.busy) void this.run();
  }

  private async run() {
    this.busy = true;
    try {
      const win = await followerWin();
      while (win) {
        if (this.want && this.target && this.target !== this.placed) {
          this.placed = this.target; // (placed before it shows, so it doesn't show somewhere else first)
          await win.setPosition(new LogicalPosition(this.placed[0], this.placed[1]));
        } else if (this.want !== this.shown) {
          this.shown = this.want;
          await (this.shown ? win.show() : win.hide());
          this.onShown(this.shown);
        } else break;
      }
    } catch {
      // (no follower window: the copy just stops at the edge)
    }
    this.busy = false;
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
