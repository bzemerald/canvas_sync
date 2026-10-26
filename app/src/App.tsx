import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { Launcher } from "./Launcher";
import { MainWindow, StartupError } from "./MainWindow";
import { ChooseCoursesPage } from "./components/ChooseCourses";
import { MissingFolderPage } from "./components/MissingFolder";
import { SignInPage } from "./components/SignIn";
import * as api from "./lib/api";
import { applyLanguage, type LangPref } from "./lib/i18n";

// One bundle serves both windows; the window's label picks the UI.
const isLauncher = getCurrentWindow().label === "launcher";
document.documentElement.classList.toggle("launcher", isLauncher);

export default function App() {
  // Signing in, then (a folder that has never synced) choosing which courses sync, then the app.
  // The sync folder gone from where it was: finding it, or another.
  const [step, setStep] = useState<"sign in" | "folder" | "choose" | "app" | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkStep = () =>
    void api.health().then((h) => {
      setRoot(h.root);
      setStep(!h.set_up ? "sign in" : h.folder_missing ? "folder" : h.choosing ? "choose" : "app");
    }, (e) => setError(String(e.message ?? e)));

  useEffect(() => {
    // The language this window loaded with was remembered here; the backend's is the one chosen.
    void api.prefs().then((p) => applyLanguage(p.language), () => {});
    const off = listen<{ language: LangPref }>("prefs-changed", ({ payload }) => applyLanguage(payload.language));
    if (!isLauncher) checkStep();
    return () => void off.then((f) => f());
  }, []);

  if (isLauncher) return <Launcher />;
  if (error) return <StartupError message={error} />;
  if (step === null) return <div data-tauri-drag-region className="h-screen bg-bg" />;
  if (step === "sign in") return <SignInPage onDone={checkStep} />;
  if (step === "folder") return <MissingFolderPage root={root ?? ""} onDone={checkStep} />;
  // Choosing starts the first sync; the main window picks it up.
  if (step === "choose") return <ChooseCoursesPage onDone={() => setStep("app")} />;
  return <MainWindow />;
}
