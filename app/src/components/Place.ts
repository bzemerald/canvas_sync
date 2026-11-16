// A place, in the app: a list of entries you arrange (Pinned; a course's tabs, its overview's cards,
// its Tools and links: see lib/things.ts). What can be done in one is the same wherever it is: put
// something there, move it, rename it there, hide what's the place's own, take away what was put
// there (with Undo). `usePlace` is that, over the place's list and whoever saves it; `usePlaceDrag`
// makes its items things to drag (among themselves, to other places, off it) and the place
// somewhere to drop them. How it's drawn, and what else its menus offer, is each place's own.
import { useState } from "react";
import { useDropZone } from "../lib/dropZones";
import { t } from "../lib/i18n";
import { type Axis, moved, useReorder } from "../lib/reorder";
import { type Shown, changed, putIn, refill, same, without } from "../lib/things";
import type { MenuItem } from "./Menu";

export function usePlace({ entries, shown = entries, onArrange, onSay, name, taken }: {
  entries: Shown[]; // all it holds, in order, hidden ones too
  shown?: Shown[]; // those on screen, in order (some of `entries`)
  onArrange: (next: Shown[]) => void; // the place as it should be: shown at once, and saved
  onSay: (message: string, action?: { label: string; run: () => void }) => void;
  name: (e: Shown) => string; // what something is called here
  taken: (name: string, e: Shown) => string; // what to say when it's taken away
}) {
  const [renaming, setRenaming] = useState<Shown | null>(null);
  const change = (e: Shown, to: { title?: string; hidden?: boolean }) => onArrange(changed(entries, e, to));
  /** What was put there, gone again (Undo brings the place back as it was). */
  const takeAway = (e: Shown) => {
    onArrange(without(entries, e));
    onSay(taken(name(e), e), { label: t("Undo"), run: () => onArrange(entries) });
  };
  return {
    entries,
    shown,
    /** Put there, shown: at `slot` among what's shown (there already, it moves there), or last of all. */
    put: (entry: Shown, slot?: number) => onArrange(putIn(entries, shown, entry, slot)),
    /** One of those shown, moved among them (hidden ones stay where they are). */
    move: (from: number, to: number) => void (from !== to && onArrange(refill(entries, shown, moved(shown, from, to)))),
    takeAway,
    hide: (e: Shown) => change(e, { hidden: true }),
    show: (e: Shown) => change(e, { hidden: false }),
    /** Your name for it here ("": its own again). */
    rename: (e: Shown, title: string) => {
      change(e, { title });
      setRenaming(null);
    },
    renaming, // the one whose name is being typed
    isRenaming: (e: Shown) => same(e, renaming),
    startRename: (e: Shown) => setRenaming(e),
    cancelRename: () => setRenaming(null),
    /** The place's part of an item's menu: rename it, its own name back, and hide it (the place's
     * own; `last`: the only one showing, which stays) or take it away (what was put there). */
    menu: (e: Shown, say: { hide: string; takeAway: string; danger?: boolean; last?: boolean }): MenuItem[] => [
      { label: t("Rename"), onSelect: () => setRenaming(e) },
      ...(e.title ? [{ label: t("Restore original name"), onSelect: () => change(e, { title: "" }) }] : []),
      e.own
        ? { label: say.hide, disabled: say.last, onSelect: () => change(e, { hidden: true }) }
        : { label: say.takeAway, danger: say.danger, onSelect: () => takeAway(e) },
    ],
  };
}
export type Place = ReturnType<typeof usePlace>;

/** A place's items as things to drag, and the place as somewhere to drop them: `zone` (its `ref`
 * on what takes drops) and `drag` (useReorder's, for the items shown). `slotAt`: where among those
 * shown a drop at (x, y) would go; `accepts`: what it takes (all, if not said). Dropped on it, a
 * thing is put there; dragged among the others, moved; dragged off, taken away if it was put
 * there. `drop`, `moved`, `off` are the place's own ways of those (`off: null`: nothing leaves by
 * being dragged off); `itemSlotAt`: useReorder's `slotAt`, for cards. */
export function usePlaceDrag(place: Place, axis: Axis, { slotAt, accepts, drop, moved: move, off, itemSlotAt }: {
  slotAt: (x: number, y: number) => number;
  accepts?: (entry: Shown) => boolean;
  drop?: (entry: Shown, slot: number) => void;
  moved?: (from: number, to: number) => void;
  off?: ((e: Shown) => void) | null;
  itemSlotAt?: (x: number, y: number, from: number) => number;
}) {
  const zone = useDropZone(drop ?? place.put, slotAt, accepts);
  const drag = useReorder(place.shown.length, move ?? place.move, axis, {
    zone: zone.id,
    thing: (i) => place.shown[i],
    remove: off === null ? undefined : (i) => (place.shown[i].own ? null : () => (off ?? place.takeAway)(place.shown[i])),
    slotAt: itemSlotAt,
  });
  return { zone, drag };
}
