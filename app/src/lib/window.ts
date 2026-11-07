// The window's frame. On macOS the title bar is the toolbar (titleBarStyle: Overlay): the
// window controls sit in the sidebar's top row, and empty toolbar space drags the window. On
// Windows the app draws them itself (components/WindowControls.tsx), at the toolbar's right end.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { isMac, platform } from "./keys";

export const ownFrame = platform === "windows";

/** Whether to leave room for the window controls (macOS, not in full screen where they hide). */
export function useTrafficLights(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!isMac) return;
    const w = getCurrentWindow();
    const check = () => void w.isFullscreen().then(setFullscreen, () => {});
    check();
    const off = w.onResized(check);
    return () => void off.then((f) => f());
  }, []);
  return isMac && !fullscreen;
}
