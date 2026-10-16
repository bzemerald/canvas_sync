import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DragGhost } from "./components/DragGhost";
import "./index.css";

// The window that carries a dragged thing past the main window's edge is just that copy.
const ghost = getCurrentWindow().label === "ghost";
document.documentElement.classList.toggle("ghost", ghost);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  ghost ? <DragGhost /> : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);

