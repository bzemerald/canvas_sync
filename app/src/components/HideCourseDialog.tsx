import { useState } from "react";
import * as api from "../lib/api";
import type { Course } from "../lib/api";
import { friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { Button, Dialog } from "./Dialog";

/** Hide a course you don't need to see (an orientation, a finished training), and usually stop
 * syncing it too. It's kept at the bottom of the sidebar, to bring back. */
export function HideCourseDialog({ course, onClose, onDone }: { course: Course; onClose: () => void; onDone: () => void }) {
  const [stopSyncing, setStopSyncing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hide = async () => {
    setBusy(true);
    try {
      await api.hideCourse(course.id, true, stopSyncing ? false : undefined);
      onDone();
    } catch (e) {
      setError(friendly((e as Error).message));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("隐藏“{name}”？", { name: course.label })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button primary autoFocus disabled={busy} onClick={() => void hide()}>{t("隐藏")}</Button>
        </>
      }
    >
      <p className="text-fg-soft">{t("它会从侧栏、搜索和新内容提醒里消失。随时可以在侧栏最下面的“已隐藏的课程”里找回。")}</p>
      <label className="mt-3 flex items-start gap-2 text-fg-soft">
        <input type="checkbox" className="mt-1" checked={stopSyncing} onChange={(e) => setStopSyncing(e.target.checked)} />
        <span>
          {t("同时停止同步这门课")}
          <span className="block text-xs text-muted">{t("Canvas 上的新内容不再下载；已经下载的文件留在原处。")}</span>
        </span>
      </label>
      {error && <p className="mt-2 text-danger">{error}</p>}
    </Dialog>
  );
}
