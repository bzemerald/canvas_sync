// Most things in the app can be pinned to the sidebar: courses, folders, files, a course's
// announcements, assignments, pages, modules and tools, web links. Drag one onto 置顶, or
// right-click it: 置顶 / 取消置顶. The window provides what pinning takes (PinsContext).
import { createContext, useContext } from "react";
import type { MenuItem } from "../components/Menu";
import type { PinTarget } from "./api";
import { t } from "./i18n";
import { dragToPin } from "./pinZone";

export interface Pins {
  isPinned: (target: PinTarget) => boolean;
  pin: (target: PinTarget) => void;
  unpin: (target: PinTarget) => void;
  menu: (items: MenuItem[], x: number, y: number) => void;
}

export const PinsContext = createContext<Pins | null>(null);

/** 置顶, or 取消置顶 if it is. */
export function pinMenuItem(pins: Pins, target: PinTarget): MenuItem {
  return pins.isPinned(target)
    ? { label: t("取消置顶"), onSelect: () => pins.unpin(target) }
    : { label: t("置顶"), onSelect: () => pins.pin(target) };
}

/** `pinnable(target, more)`: props for an element that can be pinned: press it and drag it onto
 * 置顶, or right-click it for a menu (`more`, then 置顶). No target: nothing. */
export function usePinnable() {
  const pins = useContext(PinsContext);
  return (target: PinTarget | null | undefined, more: MenuItem[] = []) => {
    if (!pins || !target) return {};
    return {
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-drag]")) return;
        dragToPin(e, e.currentTarget, target);
      },
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        pins.menu([...more, ...(more.length ? ["separator" as const] : []), pinMenuItem(pins, target)], e.clientX, e.clientY);
      },
    };
  };
}

/** Just the dragging, for things with menus of their own (that offer 置顶 themselves). */
export function useDragToPin() {
  const pins = useContext(PinsContext);
  return (target: PinTarget | null | undefined) =>
    pins && target
      ? {
          onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
            if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-drag]")) return;
            dragToPin(e, e.currentTarget, target);
          },
        }
      : {};
}
