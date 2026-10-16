import { useState } from "react";
import * as api from "../lib/api";
import type { Course } from "../lib/api";
import { friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { Button, Dialog } from "./Dialog";

/** Hide a course you don't need to see (an orientation, a finished training), or a whole past
 * term, and usually stop syncing them too. They wait at the bottom of the sidebar, to bring back. */
export function HideCourseDialog({ courses, term, onClose, onDone }: {
  courses: Course[];
  term?: string; // hiding the whole term
  onClose: () => void;
  onDone: () => void;
}) {
  const [stopSyncing, setStopSyncing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const one = courses.length === 1 && !term;
  const hide = async () => {
    setBusy(true);
    try {
      await api.hideCourses(courses.map((c) => c.id), true, stopSyncing ? false : undefined);
      onDone();
    } catch (e) {
      setError(friendly((e as Error).message));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={one ? t("隐藏“{name}”？", { name: courses[0].label }) : t("隐藏“{term}”的 {n} 门课？", { term: term ?? "", n: courses.length })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button primary autoFocus disabled={busy} onClick={() => void hide()}>{t("隐藏")}</Button>
        </>
      }
    >
      <p className="text-fg-soft">
        {one
          ? t("它会从侧栏、搜索和新内容提醒里消失。随时可以在侧栏最下面的“已隐藏的课程”里找回。")
          : t("它们会从侧栏、搜索和新内容提醒里消失。随时可以在侧栏最下面的“已隐藏的课程”里找回。")}
      </p>
      {!one && <p className="mt-2 text-xs text-muted">{courses.map((c) => c.label).join(t("、"))}</p>}
      <label className="mt-3 flex items-start gap-2 text-fg-soft">
        <input type="checkbox" className="mt-1" checked={stopSyncing} onChange={(e) => setStopSyncing(e.target.checked)} />
        <span>
          {one ? t("同时停止同步这门课") : t("同时停止同步这些课")}
          <span className="block text-xs text-muted">{t("Canvas 上的新内容不再下载；已经下载的文件留在原处。")}</span>
        </span>
      </label>
      {error && <p className="mt-2 text-danger">{error}</p>}
    </Dialog>
  );
}
