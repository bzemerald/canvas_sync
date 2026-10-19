// Dragging files out of the app: a file, a folder or a course (its folder), dragged past the
// window's edge, becomes the system's own drag of it (src-tauri/src/dragout.rs), which the
// desktop, Finder and other apps (a chat's message box) take, as a copy. Brought back over the
// window, it can still be put in a place (置顶, a course's tabs...), as if it had never left.
import { invoke } from "@tauri-apps/api/core";
import { once } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "./api";
import { dropZones, type ZoneId } from "./dropZones";
import type { Shown } from "./things";

/** A thing's files, in the sync folder: a file's, a folder's, a course's folder. */
async function filesOf(thing: Shown): Promise<string[]> {
  if (thing.type === "file" || thing.type === "folder") return [thing.path];
  if (thing.type !== "course") return [];
  const dir = (await api.courses()).find((c) => c.id === thing.course)?.dir;
  return dir ? [dir] : [];
}

/** For trackDrag's `out`: hands `entry` (or `files`, in the sync folder: what's selected with it)
 * over to the system's drag. Resolves to whether it did (not for things that aren't files, or
 * files not on this computer). `from`: the place it was dragged from, which won't take it back. */
export function dragOut(entry: Shown, from?: ZoneId, files?: string[]): () => Promise<boolean> {
  return async () => {
    const inside = files ?? (await filesOf(entry).catch(() => []));
    if (!inside.length) return false;
    const { root } = await api.health();
    if (!root) return false;
    const paths = inside.map((p) => `${root}/${p}`);
    const scale = await getCurrentWindow().scaleFactor();
    // Back over the window, the places that take it show it, and the one it's let go on takes it.
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      dropZones.end();
      void off.then((f) => f());
    };
    const off = getCurrentWebview().onDragDropEvent(({ payload: p }) => {
      if (done) return;
      if (p.type === "leave") return dropZones.end();
      const [x, y] = [p.position.x / scale, p.position.y / scale];
      if (p.type !== "drop") return void dropZones.update(x, y, entry, from);
      dropZones.drop(x, y, entry, from);
      end();
    });
    // (Let go on the window, its drop can come after this.)
    const ended = once("drag-out-ended", () => void setTimeout(end, 500));
    await off;
    if (await invoke<boolean>("drag_out", { paths }).catch(() => false)) return true;
    end();
    void ended.then((f) => f());
    return false;
  };
}
