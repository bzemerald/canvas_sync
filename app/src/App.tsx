import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { Launcher } from "./Launcher";
import { MainWindow, StartupError } from "./MainWindow";
import { Setup, firstScreen, keptFlow, onSwitchAccount, type Screen } from "./components/Setup";
import { WindowControls } from "./components/WindowControls";
import * as api from "./lib/api";
import { applyLanguage, t, type LangPref } from "./lib/i18n";
import { loadLauncherKeys } from "./lib/launcherKeys";
import { ownFrame } from "./lib/window";

// One bundle serves both windows; the window's label picks the UI.
const isLauncher = getCurrentWindow().label === "launcher";
document.documentElement.classList.toggle("launcher", isLauncher);

export default function App() {
  // Getting to the app (Setup.tsx), then the app. Starting the flow over: a new key.
  const [flow, setFlow] = useState<{ start: Screen[]; key: number } | "app" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const begin = (start: Screen[]) => setFlow({ start, key: Date.now() });
  // A flow under way in this window goes on (switching account is signed out, set up all the same).
  const check = () =>
    void api.health().then((h) => {
      const first = firstScreen(h);
      const kept = keptFlow();
      if (kept) begin(kept);
      else if (first) begin([first]);
      else setFlow("app");
    }, (e) => setError(String(e.message ?? e)));

  useEffect(() => {
    // The language this window loaded with was remembered here; the backend's is the one chosen.
    void api.prefs().then((p) => applyLanguage(p.language), () => {});
    const off = listen<{ language: LangPref }>("prefs-changed", ({ payload }) => applyLanguage(payload.language));
    let forget: (() => void) | undefined;
    if (!isLauncher) {
      check();
      const offMissing = api.onFolderMissing(check); // (gone while the app runs: ask where)
      const offSwitch = onSwitchAccount(begin);
      forget = () => (offMissing(), offSwitch());
      void loadLauncherKeys().catch(() => {});
      void invoke("set_tray_labels", { open: t("打开主窗口"), quit: t("退出") }).catch(() => {}); // (Windows has one)
    }
    return () => {
      void off.then((f) => f());
      forget?.();
    };
  }, []);

  if (isLauncher) return <Launcher />;
  const page = () => {
    if (error) return <StartupError message={error} />;
    if (flow === null) return <div data-tauri-drag-region className="h-screen bg-bg" />;
    if (flow !== "app") return <Setup key={flow.key} start={flow.start} onFinish={() => setFlow("app")} />;
    return <MainWindow />;
  };
  return (
    <>
      {page()}
      {ownFrame && <WindowControls />}
    </>
  );
}
