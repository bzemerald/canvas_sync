import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { DeletePreview } from "../lib/api";
import { trashName } from "../lib/keys";
import { Button, Dialog } from "./Dialog";
import { t } from "../lib/i18n";

/** Confirms a delete: says what goes to the Trash and what stops syncing. */
export function DeleteDialog({ paths, label, onClose, onDone }: {
  paths: string[];
  label: string; // "lec1.pdf", or "3 项"
  onClose: () => void;
  onDone: (deleted: string[]) => void;
}) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [stopFolders, setStopFolders] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.deletePreview(paths).then(setPreview, (e) => setError(e.message));
  }, [paths]);

  const go = async () => {
    setBusy(true);
    try {
      onDone((await api.deletePaths(paths, stopFolders)).deleted);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("把 {label} 移到{trash}？", { label, trash: trashName })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button danger autoFocus disabled={!preview || busy} onClick={go}>{t("移到{trash}", { trash: trashName })}</Button>
        </>
      }
    >
      {error && <p className="text-danger">{error}</p>}
      {!preview && !error && <p className="text-muted">{t("正在检查…")}</p>}
      {preview && (
        <div className="space-y-2 text-fg-soft">
          {preview.canvas_files > 0 && (
            <p>
              {t("其中 {n} 个文件来自 Canvas：之后同步时不会再下载。需要时在文件夹空白处右键，打开“显示改动”，再右键恢复。", { n: preview.canvas_files })}
            </p>
          )}
          {preview.own_files > 0 && <p>{t("你自己的 {n} 个文件会在{trash}里。", { n: preview.own_files, trash: trashName })}</p>}
          {preview.canvas_files === 0 && preview.own_files === 0 && <p>{t("这里面没有文件。")}</p>}
          {preview.canvas_folders.length > 0 && (
            <label className="mt-3 flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={stopFolders} onChange={(e) => setStopFolders(e.target.checked)} />
              <span>
                {preview.canvas_folders.length > 1 ? t("以后 Canvas 在这些文件夹里新增的文件也不下载") : t("以后 Canvas 在这个文件夹里新增的文件也不下载")}
                <span className="block text-xs text-muted">{t("不勾选的话，下次同步时文件夹会带着新文件回来（已删除的文件不会）。")}</span>
              </span>
            </label>
          )}
        </div>
      )}
    </Dialog>
  );
}
