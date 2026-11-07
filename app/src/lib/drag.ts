// Dragging things around the app: a press becomes a drag once the pointer has moved a few
// pixels (so clicks stay clicks); while dragging, a copy of what's dragged follows the pointer,
// lists scroll when you get near their edge, and the click that ends a drag isn't a click.
// Pointer events rather than HTML5 drag and drop, which on Windows fights the webview's own
// handling of files dropped on the window, and leaves no say over what dragging looks like.
// Where the copy would be cut off by the window's edge, a window of its own carries it on.
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { Springs } from "./spring";

/** Where a drag is, for how the copy looks: over a place that takes it (置顶, a course's tabs, its
 * overview): it shrinks out of the way of what shows there; dragged off its list to take it away:
 * faded, with a minus. */
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
  /** Dragged out of the window: hand it over to the system's drag (lib/dragOut.ts), if it's
   * files. True if it did: then it's over here, as if cancelled. */
  out?: () => Promise<boolean>;
}

const THRESHOLD = 5; // px before a press is a drag
const GHOST_MAX = 260; // px tall at most: a long card or term follows as its top part
const GHOST_FADE = GHOST_MAX * 0.3; // px at its bottom that fade out, when it's cut short

/** Start watching a press on `source`; it becomes a drag if the pointer moves. */
export function trackDrag(e: React.PointerEvent, source: HTMLElement, h: DragHandlers): void {
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: Ghost | null = null;
  let scroller: AutoScroll | null = null;
  let last = { x: startX, y: startY };
  let origin: [number, number] | null = null; // the page's top left on the screen
  void pageOrigin().then((o) => (origin = o));
  let handing = false; // out of the window: being handed to the system (once a drag)

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("wheel", wheel);
    scroller?.stop();
    document.documentElement.classList.remove("dragging");
  };
  /** What's under the pointer now, and the copy showing what letting go would do. */
  const hover = (x: number, y: number) => {
    const over = h.onMove?.(x, y);
    ghost?.compact(over === "zone");
    ghost?.removing(over === "remove");
  };
  const move = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      ghost = new Ghost(source, startX, startY);
      scroller = new AutoScroll(source, () => hover(last.x, last.y));
      // Not selecting text on the way (the press was the start of a selection too), nor pointing
      // at what's passed over. So the wheel has to be passed on to what's under the pointer.
      document.documentElement.classList.add("dragging");
      window.addEventListener("wheel", wheel, { passive: true });
      window.getSelection()?.removeAllRanges();
      h.onStart?.();
    }
    scroller?.update(ev.clientX, ev.clientY);
    hover(ev.clientX, ev.clientY);
    if (h.out && !handing && outside(ev)) {
      handing = true;
      void h.out().catch(() => false).then((handed) => {
        if (!handed || !ghost) return; // (not files; or let go meanwhile)
        finish();
        ghost.remove();
        ghost = null;
        h.onCancel?.();
        h.onSettled?.();
      });
    }
    ghost.move(ev.clientX, ev.clientY, origin ?? undefined);
  };
  const wheel = (ev: WheelEvent) => {
    scrollUnder(ev);
    hover(last.x, last.y);
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
      ev.stopPropagation(); // (it's only the drag's, not what else Esc would close)
      cancel();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}

/** Scrolls what's under the pointer, as the wheel would if it weren't dragging. */
function scrollUnder(ev: WheelEvent) {
  const page = document.documentElement;
  page.classList.remove("dragging"); // (for a moment: else nothing's under it)
  let el = document.elementFromPoint(ev.clientX, ev.clientY);
  page.classList.add("dragging");
  for (; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    const down = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    const across = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    if (down || across) {
      el.scrollBy(across ? ev.deltaX || (down ? 0 : ev.deltaY) : 0, down ? ev.deltaY : 0);
      return;
    }
  }
}

const outside = (ev: PointerEvent) => ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;

/** Where the page's top left is on the screen, in points. Not from the event's screenX/Y: on
 * macOS WebKit counts those from the top of the window's own screen, so on a display above or
 * below the main one the copy would show on the wrong screen. */
async function pageOrigin(): Promise<[number, number] | null> {
  try {
    const win = getCurrentWindow();
    const [at, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
    return [at.x / scale, at.y / scale];
  } catch {
    return null;
  }
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

/** A copy of `source`, laid out as a face of the copy that's dragged: as wide as it says, so it
 * doesn't lay out again as the copy changes size. */
function faceOf(source: HTMLElement, width: number): HTMLElement {
  const el = source.cloneNode(true) as HTMLElement;
  el.removeAttribute("id");
  el.setAttribute("aria-hidden", "true");
  el.dataset.face = "";
  delete el.dataset.placeholder; // (a card's own place, while it's dragged, shows as an empty slot)
  Object.assign(el.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${width}px`,
    margin: "0",
    transform: "none",
    transition: "none",
    background: "var(--panel)",
    color: "var(--fg)",
    borderRadius: "inherit",
  });
  return el;
}

/** Its height, kept to what follows the pointer: a tall one as its top part, fading out at the
 * copy's bottom edge (let go, the copy grows back to all of it, and the fade goes). */
function fitted(face: HTMLElement, height: number): number {
  face.style.height = `${height}px`;
  if (height > GHOST_MAX) face.style.maskImage = "linear-gradient(to bottom, black calc(var(--ghost-h) - var(--ghost-fade)), transparent var(--ghost-h))";
  return Math.min(height, GHOST_MAX);
}

/** What's dragged, as it looks out of the way of what a place shows (see Ghost.compact). Any
 * element will do: the copy changes to it, and back, whatever it looks like. */
function compactFace(source: HTMLElement, width: number): HTMLElement {
  return faceOf(source, Math.min(width, COMPACT_MAX));
}

const COMPACT_AFTER = 500; // ms over a place before it gets out of the way (leaving is at once)
const COMPACT_MAX = 220; // px wide at most, out of the way
const COMPACT_AT: [number, number] = [-12, -10]; // below and right of the pointer

/** A copy of what's dragged, under the pointer, held where it was grabbed. It's a box with faces:
 * how big the box is, where it's held and which face shows are numbers that glide (lib/spring.ts),
 * and can change again on the way. The pointer's own moves aren't among them: it stays with it. */
class Ghost {
  private el: HTMLElement;
  private body: HTMLElement; // the faces (the minus, on top, doesn't fade with them)
  private full: HTMLElement;
  private small: { face: HTMLElement; width: number; height: number } | null = null; // (made when first needed)
  private source: HTMLElement;
  private springs: Springs<"w" | "h" | "dx" | "dy" | "compact" | "scale" | "opacity" | "fade">;
  private size: { w: number; h: number };
  private grabbed: [number, number]; // dx, dy as grabbed
  private pointer: { x: number; y: number };
  private origin: [number, number] | null = null; // the page's top left on the screen
  private isCompact = false;
  private compactSoon = 0; // the wait before it is
  private landing = false;
  private frame = 0;
  private lastFrame = 0;
  private atRest: (() => void)[] = [];
  private badge: HTMLElement | null = null; // the minus: let go, and it's taken away
  private follower: Follower;
  private following = false; // cut off by the window's edge: the follower carries it

  constructor(source: HTMLElement, x: number, y: number) {
    this.source = source;
    const r = source.getBoundingClientRect();
    this.pointer = { x, y };
    this.grabbed = [x - r.left, Math.min(y - r.top, GHOST_MAX - 12)];
    this.full = faceOf(source, r.width);
    this.full.style.opacity = "calc(1 - var(--ghost-compact))";
    this.size = { w: r.width, h: fitted(this.full, r.height) };
    this.springs = new Springs(
      { w: this.size.w, h: this.size.h, dx: this.grabbed[0], dy: this.grabbed[1], compact: 0, scale: LIFTED, opacity: 0.95, fade: GHOST_FADE },
      { w: 0.2, h: 0.2, dx: 0.2, dy: 0.2, compact: 0.003, scale: 0.001, opacity: 0.003, fade: 0.2 },
    );
    this.body = document.createElement("div");
    this.body.style.cssText = "position: absolute; inset: 0; border-radius: inherit; overflow: hidden";
    this.body.appendChild(this.full);
    const el = document.createElement("div");
    el.dataset.ghost = "";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = `position: fixed; left: 0; top: 0; width: var(--ghost-w); height: var(--ghost-h); opacity: var(--ghost-opacity);
      pointer-events: none; z-index: 1000; border-radius: 10px; background: var(--panel); will-change: transform;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.32), 0 0 0 1px var(--line)`;
    el.appendChild(this.body);
    document.body.appendChild(el);
    this.el = el;
    this.follower = new Follower((shown) => void (this.el.style.visibility = shown && this.following ? "hidden" : ""));
    this.paint();
    this.sync();
  }

  private get vars(): Record<string, string> {
    const v = this.springs.values;
    return { "--ghost-w": `${v.w}px`, "--ghost-h": `${v.h}px`, "--ghost-compact": String(v.compact), "--ghost-opacity": String(v.opacity), "--ghost-fade": `${v.fade}px` };
  }

  private paint() {
    const v = this.springs.values;
    for (const [k, value] of Object.entries(this.vars)) this.el.style.setProperty(k, value);
    this.el.style.transform = `translate(${this.pointer.x - v.dx}px, ${this.pointer.y - v.dy}px) scale(${v.scale})`;
  }

  /** Where the window's edge would cut the copy off (dragging a pin out of the sidebar, say), the
   * follower carries it there. */
  private place() {
    if (!this.origin || this.landing) return;
    const v = this.springs.values;
    const [left, top] = [this.pointer.x - v.dx, this.pointer.y - v.dy];
    if (left < 0 || top < 0 || left + v.w > window.innerWidth || top + v.h > window.innerHeight) {
      if (!this.following) this.follower.vars(this.vars);
      this.following = true;
      this.follower.show(this.origin[0] + left, this.origin[1] + top);
    } else if (this.following) {
      this.following = false;
      this.el.style.visibility = "";
      this.follower.hide();
    }
  }

  /** Off to where the springs are told to go. */
  private glide() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.springs.jump();
      this.frameDone();
    } else if (!this.frame && !this.springs.settled) {
      this.lastFrame = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    this.springs.tick((now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.frameDone();
    this.frame = this.springs.settled ? 0 : requestAnimationFrame(this.tick);
    if (!this.frame) for (const done of this.atRest.splice(0)) done();
  };

  private frameDone() {
    this.paint();
    this.place();
    if (this.following) this.follower.vars(this.vars);
  }

  /** At (x, y) in the window; `origin`: the page's top left on the screen. */
  move(x: number, y: number, origin?: [number, number]) {
    this.pointer = { x, y };
    if (origin) this.origin = origin;
    this.paint();
    this.place();
  }

  /** The follower gets the copy as it looks now, every face. */
  private sync() {
    const copy = this.el.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, { position: "relative", left: "0px", top: "0px", transform: "none", visibility: "visible", zIndex: "auto" });
    copy.querySelectorAll<HTMLElement>("[data-face]").forEach((face) => inlineImages(this.source, face));
    this.follower.content(copy.outerHTML, Math.max(this.size.w, this.small?.width ?? 0), Math.max(this.size.h, this.small?.height ?? 0));
  }

  /** Its compact face, made and measured the first time it's asked for. */
  private compactSize() {
    if (!this.small) {
      const face = compactFace(this.source, this.size.w);
      const width = parseFloat(face.style.width);
      face.style.opacity = "var(--ghost-compact)";
      this.body.appendChild(face);
      this.small = { face, width, height: fitted(face, face.offsetHeight) };
      this.sync();
    }
    return this.small;
  }

  /** Over a place that shows where it'll go (置顶, a course's tabs): after a moment there, smaller,
   * and below and right of the pointer, so that shows. Away from it: back at once. */
  compact(on: boolean) {
    if (on) {
      if (!this.isCompact && !this.compactSoon) this.compactSoon = window.setTimeout(() => this.setCompact(true), COMPACT_AFTER);
    } else {
      window.clearTimeout(this.compactSoon);
      this.compactSoon = 0;
      if (this.isCompact) this.setCompact(false);
    }
  }

  private setCompact(on: boolean) {
    this.compactSoon = 0;
    this.isCompact = on;
    if (on) {
      const { width, height } = this.compactSize();
      this.springs.set({ w: width, h: height, dx: COMPACT_AT[0], dy: COMPACT_AT[1], compact: 1, opacity: 0.85 });
    } else {
      this.springs.set({ w: this.size.w, h: this.size.h, dx: this.grabbed[0], dy: this.grabbed[1], compact: 0, opacity: 0.95 });
    }
    this.glide();
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
      this.body.style.opacity = "0.45"; // (what's in it fades; the minus doesn't)
      this.el.appendChild(b);
      this.badge = b;
    } else {
      this.badge?.remove();
      this.badge = null;
      this.body.style.opacity = "";
    }
    this.sync();
  }

  /** Let go: it glides into `to` and settles there (or fades out where it is); then it's gone.
   * (Carried by the follower, past the window's edge: back in the page for that, gliding in.) */
  async land(to: Landing) {
    window.clearTimeout(this.compactSoon);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return this.remove();
    this.landing = true;
    if (this.following) {
      if (!to?.isConnected) return this.remove(); // (let go outside the window: nothing to glide into)
      this.following = false;
      this.el.style.visibility = "";
      this.follower.hide();
    }
    // (Not forever: the window hidden, nothing draws, so nothing would get there.)
    const tooLong = new Promise<void>((done) => setTimeout(done, LAND * 2));
    await Promise.race([new Promise(requestAnimationFrame), tooLong]); // (the page has its new order by now)
    const r = to?.isConnected ? settledRect(to) : null;
    this.el.style.transition = `box-shadow ${LAND}ms`;
    if (r) {
      this.el.style.boxShadow = "0 0 0 1px var(--line)";
      this.springs.set({ w: r.width, h: r.height, fade: 0, dx: this.pointer.x - r.left, dy: this.pointer.y - r.top, compact: 0, scale: 1, opacity: 1 });
    } else {
      this.springs.set({ scale: 0.92, opacity: 0 });
    }
    await new Promise<void>((done) => {
      this.atRest.push(done);
      void tooLong.then(done);
      this.glide();
      if (this.springs.settled) done();
    });
    this.remove();
  }

  remove() {
    window.clearTimeout(this.compactSoon);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.follower.hide();
    this.el.remove();
  }
}

const LIFTED = 1.02; // a little bigger while it's carried
const LAND = 200; // ms: the copy gliding into place when let go

/** Where it ends up: its box without the glide it may be in the middle of (lib/flip.ts). */
function settledRect(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect();
  const m = new DOMMatrix(getComputedStyle(el).transform);
  return new DOMRect(r.left - m.m41, r.top - m.m42, r.width, r.height);
}

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

  /** How the copy is just now: its size and which face shows (see Ghost). */
  vars(vars: Record<string, string>) {
    void emitTo("ghost", "drag-ghost-vars", vars).catch(() => {});
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
