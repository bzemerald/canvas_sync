// The window that carries what's being dragged once it reaches the main window's edge (see
// lib/drag.ts): a page can't draw past its window, so this one, transparent and letting the
// pointer through, shows a copy of it, sent from there.
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

export function DragGhost() {
  const [html, setHtml] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = listen<{ html: string }>("drag-ghost", ({ payload }) => setHtml(payload.html));
    // How it is just now, as it changes: only these numbers are sent (see Ghost in lib/drag.ts).
    const offVars = listen<Record<string, string>>("drag-ghost-vars", ({ payload }) => {
      const ghost = box.current?.querySelector<HTMLElement>("[data-ghost]");
      if (ghost) for (const [k, v] of Object.entries(payload)) ghost.style.setProperty(k, v);
    });
    return () => {
      void off.then((f) => f());
      void offVars.then((f) => f());
    };
  }, []);
  // What's sent is a copy of the app's own page (escaped as it was there).
  return <div ref={box} dangerouslySetInnerHTML={{ __html: html }} />;
}
