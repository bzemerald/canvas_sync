// Quick Look: on macOS the system's panel, zooming out of the file's icon and back into it, as in
// Finder (src-tauri/src/quicklook.rs); elsewhere the file just opens. Icons on screen say which
// file they are with `data-ql`.
import { invoke } from "@tauri-apps/api/core";
import * as api from "./api";
import { isMac } from "./keys";

/** Where a file's icon is in the page, if it's on screen (not scrolled away or covered). */
function iconOf(path: string): [number, number, number, number] | undefined {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-ql="${CSS.escape(path)}"]`)) {
    const icon = el.querySelector("img, svg") ?? el;
    const r = icon.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (r.width > 0 && top && el.contains(top)) return [r.x, r.y, r.width, r.height];
  }
}

/**
 * Show `paths` (in the sync folder; the one at `index` first). `how`: "open" it; "toggle", the
 * same but close it if it's open (Space); "follow", only if it's open (the selection changed).
 * Resolves true if a file was shown (and so marked seen).
 */
export async function quickLook(paths: string[], index: number, how: "open" | "toggle" | "follow"): Promise<boolean> {
  if (!isMac) {
    if (how === "follow" || !paths[index]) return false;
    await api.openPath(paths[index], { preview: true });
    return true;
  }
  const { root } = await api.health();
  if (!root) return false;
  const items = paths.map((p) => ({ path: `${root}/${p}`, icon: iconOf(p) }));
  const shown = await invoke<boolean>("quick_look", { items, index, open: how !== "follow", toggle: how === "toggle" });
  if (shown) await api.sawFile(paths[index]);
  return shown;
}
