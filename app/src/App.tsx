import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { Launcher } from "./Launcher";
import { MainWindow, StartupError } from "./MainWindow";
import { ChooseCourses } from "./components/ChooseCourses";
import { MissingFolderPage } from "./components/MissingFolder";
import { SignInForm } from "./components/SignIn";
import { Welcome } from "./components/Welcome";
import { WindowControls } from "./components/WindowControls";
import * as api from "./lib/api";
import { applyLanguage, t, type LangPref } from "./lib/i18n";
import { loadLauncherKeys } from "./lib/launcherKeys";
import { ownFrame } from "./lib/window";

// One bundle serves both windows; the window's label picks the UI.
const isLauncher = getCurrentWindow().label === "launcher";
const BACK = "sign-in-back";
document.documentElement.classList.toggle("launcher", isLauncher);

export default function App() {
  // Signing in, then (a folder that has never synced) choosing which courses sync, then the app.
  // The sync folder gone from where it was: finding it, or another.
  const [step, setStep] = useState<"sign in" | "folder" | "choose" | "app" | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Back from choosing the courses to signing in (kept across a reload: changing the language).
  const [again, setAgain] = useState<api.AccountInfo | null>(null);
  const goBack = (on: boolean) => {
    try {
      if (on) sessionStorage.setItem(BACK, "1");
      else sessionStorage.removeItem(BACK);
    } catch { /* (then a reload goes to the courses again) */ }
  };
  const back = () => {
    goBack(true);
    void api.account().then((a) => (setAgain(a), setStep("sign in")), (e) => setError(String(e.message ?? e)));
  };
  const checkStep = (signedIn = false) =>
    void api.health().then((h) => {
      setRoot(h.root);
      if (signedIn) goBack(false);
      let backed = false;
      try {
        backed = sessionStorage.getItem(BACK) === "1";
      } catch { /* (no) */ }
      if (h.set_up && h.choosing && backed) return back();
      setStep(!h.set_up ? "sign in" : h.folder_missing ? "folder" : h.choosing ? "choose" : "app");
    }, (e) => setError(String(e.message ?? e)));

  useEffect(() => {
    // The language this window loaded with was remembered here; the backend's is the one chosen.
    void api.prefs().then((p) => applyLanguage(p.language), () => {});
    const off = listen<{ language: LangPref }>("prefs-changed", ({ payload }) => applyLanguage(payload.language));
    let forget: (() => void) | undefined;
    if (!isLauncher) {
      checkStep();
      forget = api.onFolderMissing(() => checkStep()); // (gone while the app runs: ask where)
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
    if (step === null) return <div data-tauri-drag-region className="h-screen bg-bg" />;
    // (One Welcome for both: from signing in to the courses, its box glides.)
    if (step === "sign in") return (
      <Welcome title={t("连接 Canvas")}>
        <SignInForm key={again ? "again" : "new"} keep onDone={() => checkStep(true)} {...again && {
          folder: again.root ?? undefined, address: again.base_url ?? undefined, auth: again.auth, start: "auth" as const,
        }} />
      </Welcome>
    );
    if (step === "folder") return <MissingFolderPage root={root ?? ""} onDone={checkStep} />;
    // Choosing starts the first sync; the main window picks it up.
    if (step === "choose") return (
      <Welcome title={t("选择要同步的课程")}>
        <ChooseCourses submitLabel={t("开始同步")} onDone={() => setStep("app")} onBack={back} />
      </Welcome>
    );
    return <MainWindow />;
  };
  return (
    <>
      {page()}
      {ownFrame && <WindowControls />}
    </>
  );
}
