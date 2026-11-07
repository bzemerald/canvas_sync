// What search found, marked on the page it opened, whoever draws the page, and as it loads and
// changes. With `tools` (opened from search, not narrowing a list as you type): it goes to what's
// found, if that's not in view, with a way through them and a way to stop.
//
// Marked with <mark> elements: WebKit paints CSS highlights unreliably (text that isn't in any
// range, and not text that is; what was marked stays on the screen). Text can be split into them
// where React holds no text node: HTML set as such, and an element whose only child is a string.
// Text next to other children is React's own: it'd fail on finding the node moved, so it's left.
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { type Piece, compiled, locate } from "../lib/marks";

const SKIP = "input, textarea, select, script, style, svg, mark, [data-no-mark]";

const reactsOwn = (text: Text) => Object.keys(text).some((k) => k.startsWith("__reactFiber$"));

/** The block an element's text is in. */
function blockOf(el: Element, root: Element, known: Map<Element, Element>): Element {
  const was = known.get(el);
  if (was) return was;
  const block = el === root || getComputedStyle(el).display !== "inline" || !el.parentElement ? el : blockOf(el.parentElement, root, known);
  known.set(el, block);
  return block;
}

/** Marks what `re` finds under `root`. Each found thing is its marks (more than one, across
 * elements: <strong>Midterm</strong> 2), in the page's order. */
function mark(root: Element, re: RegExp): HTMLElement[][] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n instanceof Element && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  const pieces: Piece[] = [];
  const known = new Map<Element, Element>();
  let block: Element | null = null;
  let broke = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n instanceof Element) {
      broke ||= n.tagName === "BR";
      continue;
    }
    const text = n as Text;
    if (reactsOwn(text)) {
      broke = true;
      continue;
    }
    const here = blockOf(text.parentElement!, root, known);
    pieces.push({ text: text.data, block: broke || here !== block });
    nodes.push(text);
    block = here;
    broke = false;
  }
  const places = locate(pieces, re);
  // Each node's parts of what's found, from its end, so that what's before stays where it is.
  const parts = new Map<number, { place: number; from: number; to: number }[]>();
  places.forEach(({ from, to }, place) => {
    for (let i = from[0]; i <= to[0]; i++) {
      const part = { place, from: i === from[0] ? from[1] : 0, to: i === to[0] ? to[1] : nodes[i]!.length };
      if (part.to > part.from) parts.set(i, [...(parts.get(i) ?? []), part]);
    }
  });
  const found: HTMLElement[][] = places.map(() => []);
  for (const [i, list] of parts) {
    for (const { place, from, to } of [...list].reverse()) {
      const el = document.createElement("mark");
      el.dataset.found = "";
      const range = new Range();
      range.setStart(nodes[i]!, from);
      range.setEnd(nodes[i]!, to);
      range.surroundContents(el);
      found[place]!.unshift(el);
    }
  }
  return found.filter((f) => f.length);
}

function unmark(root: Element) {
  const parents = new Set<Node>();
  root.querySelectorAll("mark[data-found]").forEach((el) => {
    parents.add(el.parentNode!);
    el.replaceWith(...el.childNodes);
  });
  parents.forEach((p) => p.normalize());
}

/** What scrolls it. */
function scrollerOf(el: Element): Element | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

function inView(el: Element): boolean {
  const box = scrollerOf(el)?.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  return !box || (rect.top >= box.top && rect.bottom <= box.bottom);
}

function bringIntoView(el: Element, behavior: ScrollBehavior) {
  const scroller = scrollerOf(el);
  if (!scroller || inView(el)) return;
  const box = scroller.getBoundingClientRect();
  scroller.scrollBy({ top: el.getBoundingClientRect().top - box.top - box.height / 3, behavior });
}

export function Marked({ pattern, place, tools, onClear, children }: {
  pattern: string | null; // what to mark (lib/marks.ts)
  place: string; // where we are: somewhere else, it starts over
  tools: boolean;
  onClear: () => void;
  children: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const found = useRef<HTMLElement[][]>([]); // the ones to go through: in what's being read, if anything is
  const [count, setCount] = useState(0);
  const [at, setAt] = useState(0);
  const shown = useRef(0);

  const show = (i: number) => {
    found.current[shown.current]?.forEach((el) => delete el.dataset.current);
    shown.current = i;
    setAt(i);
    found.current[i]?.forEach((el) => (el.dataset.current = ""));
  };

  useEffect(() => {
    const el = root.current;
    if (!el || !pattern) return;
    const re = compiled(pattern);
    let gone = false; // gone to what's found, once, when it's first there
    let frame = 0;
    const update = () => {
      frame = 0;
      unmark(el);
      const all = mark(el, re);
      changes.takeRecords(); // (those were ours)
      const reading = el.querySelector("article");
      const mine = all.filter((f) => (!reading || reading.contains(f[0]!)) && f[0]!.getClientRects().length);
      found.current = mine;
      setCount(mine.length);
      if (!tools) return;
      if (!gone && mine.length) {
        gone = true;
        // (Not if some are in view: a title, or what a module or a file was opened at.)
        const seen = mine.findIndex((f) => inView(f[0]!));
        if (seen < 0) bringIntoView(mine[0]![0]!, "auto");
        show(Math.max(seen, 0));
      } else show(Math.min(shown.current, Math.max(mine.length - 1, 0)));
    };
    const changes = new MutationObserver(() => {
      frame ||= requestAnimationFrame(update);
    });
    changes.observe(el, { childList: true, characterData: true, subtree: true });
    shown.current = 0;
    update();
    return () => {
      cancelAnimationFrame(frame);
      changes.disconnect();
      unmark(el);
      found.current = [];
      setCount(0);
    };
  }, [pattern, place, tools]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = (d: number) => {
    const i = (at + d + count) % count;
    show(i);
    bringIntoView(found.current[i]![0]!, "smooth");
  };

  // Esc stops it, unless it's for something else: a menu, a dialog, a box being typed in.
  const on = tools && !!pattern && count > 0;
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector("[role=menu], [role=dialog]") || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
      onClear();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [on, onClear]);

  const button = "rounded p-1 text-muted hover:bg-chip hover:text-fg";
  return (
    <>
      <div ref={root} className="contents">{children}</div>
      {on && (
        <div data-no-drag className="fixed right-5 bottom-4 z-30 flex items-center gap-0.5 rounded-lg border border-line bg-panel py-0.5 pr-1 pl-2.5 text-xs shadow-lg">
          <span className="mr-1.5 text-fg-soft tabular-nums">{at + 1} / {count}</span>
          <button title={t("上一处")} aria-label={t("上一处")} onClick={() => step(-1)} className={button}><ChevronUp className="size-3.5" /></button>
          <button title={t("下一处")} aria-label={t("下一处")} onClick={() => step(1)} className={button}><ChevronDown className="size-3.5" /></button>
          <button title={t("清除高亮 (Esc)")} aria-label={t("清除高亮 (Esc)")} onClick={onClear} className={button}><X className="size-3.5" /></button>
        </div>
      )}
    </>
  );
}
