// The window that carries what's being dragged once it reaches the main window's edge (see
// lib/drag.ts): a page can't draw past its window, so this one, transparent and letting the
// pointer through, shows a copy of it, sent from there.
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export function DragGhost() {
  const [html, setHtml] = useState("");
  useEffect(() => {
    const off = listen<{ html: string }>("drag-ghost", ({ payload }) => setHtml(payload.html));
    return () => void off.then((f) => f());
  }, []);
  // What's sent is a copy of the app's own page (escaped as it was there).
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
