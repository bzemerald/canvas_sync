import { getCurrentWindow } from "@tauri-apps/api/window";
import { Launcher } from "./Launcher";
import { MainWindow } from "./MainWindow";

// One bundle serves both windows; the window's label picks the UI.
const isLauncher = getCurrentWindow().label === "launcher";
document.documentElement.classList.toggle("launcher", isLauncher);

export default function App() {
  return isLauncher ? <Launcher /> : <MainWindow />;
}
