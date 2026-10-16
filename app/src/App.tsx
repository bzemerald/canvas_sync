import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { Launcher } from "./Launcher";
import { MainWindow, StartupError } from "./MainWindow";
import { SignInPage } from "./components/SignIn";
import * as api from "./lib/api";
import { applyLanguage, type LangPref } from "./lib/i18n";

// One bundle serves both windows; the window's label picks the UI.
const isLauncher = getCurrentWindow().label === "launcher";
document.documentElement.classList.toggle("launcher", isLauncher);

export default function App() {
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The language this window loaded with was remembered here; the backend's is the one chosen.
    void api.prefs().then((p) => applyLanguage(p.language), () => {});
    const off = listen<{ language: LangPref }>("prefs-changed", ({ payload }) => applyLanguage(payload.language));
    if (!isLauncher) void api.health().then((h) => setSetUp(h.set_up), (e) => setError(String(e.message ?? e)));
    return () => void off.then((f) => f());
  }, []);

  if (isLauncher) return <Launcher />;
  if (error) return <StartupError message={error} />;
  if (setUp === null) return <div className="h-screen bg-bg" />;
  // Signing in starts the first sync; the main window picks it up.
  if (!setUp) return <SignInPage onDone={() => setSetUp(true)} />;
  return <MainWindow />;
}
