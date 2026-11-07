// 检查更新: new versions come from GitHub's releases (tauri.conf.json's updater endpoint, a
// latest.json the release workflow writes), signed with the key whose public half is there.
// One state for the whole window: 设置 and the sidebar show the same check.
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest" } // checked, nothing newer
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; progress: number | null } // 0..1, null: size unknown
  | { phase: "installing"; version: string }
  | { phase: "failed"; error: string; version?: string };

let state: UpdateState = { phase: "idle" };
let found: Update | null = null;
const listeners = new Set<() => void>();
const set = (s: UpdateState) => {
  state = s;
  listeners.forEach((l) => l());
};

export function useUpdate(): UpdateState {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);
}

const busy = () => state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";

/** Asks GitHub. `quiet`: a check of its own, which says nothing when it fails (offline, say). */
export async function checkForUpdate(quiet = false) {
  if (busy()) return;
  const before = state;
  if (!quiet) set({ phase: "checking" });
  try {
    found = await check();
    set(found ? { phase: "available", version: found.version } : { phase: "latest" });
  } catch (e) {
    set(quiet ? before : { phase: "failed", error: String(e) });
  }
}

/** Downloads the update, installs it, restarts. On Windows installing quits the app itself. */
export async function installUpdate() {
  if (!found || busy()) return;
  const version = found.version;
  let total = 0;
  let got = 0;
  try {
    set({ phase: "downloading", version, progress: null });
    await found.download((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        got += e.data.chunkLength;
        set({ phase: "downloading", version, progress: total ? Math.min(1, got / total) : null });
      }
    });
    set({ phase: "installing", version });
    await invoke("stop_backend_for_update");
    await found.install();
    await relaunch();
  } catch (e) {
    // The backend may be stopped by now: the old version starts again whole.
    if (state.phase === "installing") return void relaunch();
    set({ phase: "failed", error: String(e), version });
  }
}

const HOURS = 3_600_000;

/** Checks quietly a little after starting, then every 6 hours. Not in development: the copy
 * running from the repo isn't one an update could replace. */
export function startUpdateChecks(): () => void {
  if (import.meta.env.DEV) return () => {};
  const first = setTimeout(() => void checkForUpdate(true), 20_000);
  const every = setInterval(() => void checkForUpdate(true), 6 * HOURS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
