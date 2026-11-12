// Copying files and folders to the system's clipboard (src-tauri/src/clipboard.rs), as the file
// manager does: pasted in Finder or Explorer they're copied there; in a chat, attached.
import { invoke } from "@tauri-apps/api/core";
import * as api from "./api";

/** Puts these (paths in the sync folder) on the clipboard. Resolves to whether it did. */
export async function copyFiles(paths: string[]): Promise<boolean> {
  if (!paths.length) return false;
  const { root } = await api.health();
  if (!root) return false;
  return invoke<boolean>("copy_files", { paths: paths.map((p) => `${root}/${p}`) }).catch(() => false);
}
