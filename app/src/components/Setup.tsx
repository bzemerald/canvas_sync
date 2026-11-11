// Getting to the app: signing in, finding a sync folder that went missing, choosing the courses.
// One flow, a stack of screens: going on pushes the next, Back pops back to the one before (there
// is one only if the stack has one). Where it starts comes from the backend (`firstScreen`); after
// that the flow knows where it's been. The same flow switches account, in a dialog in 设置.
import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { t } from "../lib/i18n";
import { ChooseCourses } from "./ChooseCourses";
import { Dialog } from "./Dialog";
import { MissingFolderPage } from "./MissingFolder";
import { SignInForm, type Progress } from "./SignIn";
import { Welcome } from "./Welcome";

export type Screen =
  | { kind: "sign in"; progress?: Partial<Progress> } // (as far as it got, to come back to)
  | { kind: "missing"; root: string } // the sync folder isn't where it was
  | { kind: "courses" }; // a folder that never synced: which courses sync

/** Where to start, as the backend has it; null: nothing to do, on to the app. */
export function firstScreen(h: { set_up: boolean; folder_missing: boolean; choosing: boolean; root: string | null }): Screen | null {
  if (!h.set_up) return { kind: "sign in" };
  if (h.folder_missing) return { kind: "missing", root: h.root ?? "" };
  if (h.choosing) return { kind: "courses" };
  return null;
}

// A flow in the window is kept until it's done: changing the language reloads the page.
const KEPT = "setup";
export function keptFlow(): Screen[] | null {
  try {
    const got = JSON.parse(sessionStorage.getItem(KEPT) ?? "null") as Screen[] | null;
    return Array.isArray(got) && got.length ? got : null;
  } catch {
    return null;
  }
}
function keep(stack: Screen[] | null) {
  try {
    if (stack) sessionStorage.setItem(KEPT, JSON.stringify(stack));
    else sessionStorage.removeItem(KEPT);
  } catch { /* (then a reload starts it over) */ }
}

export function Setup({ start, another, onFinish, onClose }: {
  start: Screen[];
  another?: boolean; // switching account (in 设置)
  onFinish: () => void; // set up: on to the app
  onClose?: () => void; // in a dialog: closed before anything changed
}) {
  const [stack, setStack] = useState(start);
  const here = stack[stack.length - 1];
  const inDialog = !!onClose;
  // Signing in, or a new sync folder, takes effect then: closing after that doesn't undo it.
  const changed = useRef(false);
  useEffect(() => void (!inDialog && keep(stack)), [inDialog, stack]);

  const finish = () => {
    if (!inDialog) keep(null);
    onFinish();
  };
  const close = () => (changed.current ? finish() : onClose?.());
  const back = stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : undefined;
  // Signed in, or the folder found or started over: the courses next if it never synced.
  const next = () => {
    changed.current = true;
    void api.health().then((h) => (h.choosing ? setStack((s) => [...s, { kind: "courses" }]) : finish()), finish);
  };
  const progress = (p: Progress) =>
    setStack((s) => s.map((x, i) => (i === s.length - 1 && x.kind === "sign in" ? { ...x, progress: p } : x)));

  if (here.kind === "missing") return <MissingFolderPage root={here.root} onDone={next} />;
  const title = here.kind === "courses" ? t("选择要同步的课程") : another ? t("切换账号或学校") : t("连接 Canvas");
  const body = here.kind === "courses"
    ? <ChooseCourses submitLabel={t("开始同步")} onDone={finish} onBack={back} />
    : <SignInForm another={another} seed={here.progress} onProgress={progress} submitLabel={another ? t("切换") : undefined}
        onDone={next} onCancel={inDialog ? close : undefined} />;
  if (inDialog) return <Dialog title={title} onClose={close}><div className="pb-3">{body}</div></Dialog>;
  // (One Welcome for signing in and the courses: going from one to the other, its box glides.)
  return <Welcome title={title}>{body}</Welcome>;
}
