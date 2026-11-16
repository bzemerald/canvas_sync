// What a folder's contents and search results share, as a file manager: selecting (click,
// ⌘/Ctrl/Shift-click, a box), Quick Look following the selection, the keys (lib/keys.ts),
// opening, dragging and the right-click menu. Each supplies its items and draws its own rows.
import { useEffect, useMemo, useRef } from "react";
import { type FileCommand, fileCommand } from "../lib/keys";
import { quickLook } from "../lib/quicklook";
import { useMarquee, useSelection } from "../lib/selection";
import type { Shown } from "../lib/things";
import { useDragThing } from "./Things";

export type ViewMode = "list" | "grid";

export function useBrowser<T>({ items, keyOf, mode, onOpen, onMenu, onDelete, onCopy, deletable, copyable, previewPath, thing, files }: {
  items: T[]; // in the order shown
  keyOf: (item: T) => string;
  mode: ViewMode;
  onOpen: (item: T) => void; // double-click, or the open key
  onMenu: (items: T[], x: number, y: number) => void;
  onDelete: (items: T[]) => void; // only what `deletable` lets through
  onCopy: (items: T[]) => void; // the same, `copyable`
  deletable: (item: T) => boolean;
  copyable: (item: T) => boolean;
  previewPath: (item: T) => string | null | undefined; // for Quick Look (none: not previewed)
  thing: (item: T) => Shown | null | undefined; // dragged to a place
  files?: (items: T[]) => string[]; // dragged out of the window: the files that go
}) {
  const dragThing = useDragThing(); // (Pin is in their menus)
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => items.map(keyOf), [items, keyOf]);
  const byKey = useMemo(() => new Map(items.map((x) => [keyOf(x), x])), [items, keyOf]);
  const sel = useSelection(keys);
  const marquee = useMarquee(scroller, sel);
  const chosen = () => keys.filter((k) => sel.has(k)).map((k) => byKey.get(k)!);

  // What's selected, for Quick Look; when it's open it follows the selection, as in Finder.
  const previewable = items.filter((x) => sel.has(keyOf(x)) && previewPath(x));
  const preview = (how: "toggle" | "follow") =>
    quickLook(previewable.map((x) => previewPath(x)!), Math.max(0, previewable.findIndex((x) => keyOf(x) === sel.cursor)), how);
  useEffect(() => {
    void preview("follow");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewable.map(keyOf).join("\0"), sel.cursor]);

  /** The keys; `more` takes what only one of them has first (true: done). */
  const onKeyDown = (ev: React.KeyboardEvent, more?: (command: FileCommand | null, at: { i: number; go: (j: number) => void }) => boolean) => {
    const i = keys.indexOf(sel.cursor ?? "");
    const grid = scroller.current?.querySelector<HTMLElement>("[data-grid]");
    const columns = mode === "grid" && grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1;
    const go = (j: number) => {
      const k = keys[Math.max(0, Math.min(keys.length - 1, j))];
      if (k) sel.moveTo(k, ev.shiftKey);
    };
    const command = fileCommand(ev);
    const picked = chosen();
    let handled = true;
    if (command === "open") picked.forEach(onOpen);
    else if (command === "selectAll") sel.all();
    else if (command === "delete" && picked.some(deletable)) onDelete(picked.filter(deletable));
    else if (command === "copy" && picked.some(copyable)) onCopy(picked.filter(copyable));
    else if (command === "preview") void preview("toggle");
    else if (more?.(command, { i, go })) { /* (done there) */ }
    else if (ev.key === "ArrowDown") go(i < 0 ? 0 : i + columns);
    else if (ev.key === "ArrowUp") go(i < 0 ? 0 : i - columns);
    else if (ev.key === "ArrowRight" && mode === "grid") go(i + 1);
    else if (ev.key === "ArrowLeft" && mode === "grid") go(i - 1);
    else if (ev.key === "Escape") sel.clear();
    else handled = false;
    if (handled) ev.preventDefault();
  };

  /** An item's selecting, opening, dragging and menu. */
  const itemProps = (item: T) => {
    const k = keyOf(item);
    return {
      "data-key": k,
      "aria-selected": sel.has(k),
      onMouseDown: (ev: React.MouseEvent) => ev.button === 0 && ev.detail > 1 && ev.preventDefault(), // no word selection on double-click
      onClick: (ev: React.MouseEvent) => sel.click(k, ev),
      onDoubleClick: () => onOpen(item),
      // (Out of the window, what's selected goes with it, as from Finder.)
      ...dragThing(thing(item), files && (() => files(sel.has(k) ? chosen() : [item]))),
      onContextMenu: (ev: React.MouseEvent) => {
        ev.preventDefault();
        // Right-clicking outside the selection acts on that item alone, as in Finder/Explorer.
        const picked = sel.has(k) ? chosen() : [item];
        if (!sel.has(k)) sel.only(k);
        onMenu(picked, ev.clientX, ev.clientY);
      },
    };
  };
  const shade = (item: T) => (sel.has(keyOf(item)) ? "bg-selected" : "hover:bg-chip");

  return { scroller, sel, marquee, byKey, onKeyDown, itemProps, shade };
}
