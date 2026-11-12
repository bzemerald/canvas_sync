import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DragGhost } from "./components/DragGhost";
import "./index.css";

// The window that carries a dragged thing past the main window's edge is just that copy.
const ghost = getCurrentWindow().label === "ghost";
document.documentElement.classList.toggle("ghost", ghost);

// Right-clicked where we have no menu: none, not the web view's (Reload, Inspect Element). Text
// boxes and selected text keep the system's (paste; copy, look up).
window.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement | null;
  if (el?.closest("input, textarea, [contenteditable]:not([contenteditable=false])")) return;
  if (window.getSelection()?.toString()) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  ghost ? <DragGhost /> : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);

