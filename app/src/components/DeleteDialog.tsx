import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { DeletePreview } from "../lib/api";
import { trashName } from "../lib/keys";
import { Button, Dialog } from "./Dialog";

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
      title={`把 ${label} 移到${trashName}？`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button danger autoFocus disabled={!preview || busy} onClick={go}>移到{trashName}</Button>
        </>
      }
    >
      {error && <p className="text-danger">{error}</p>}
      {!preview && !error && <p className="text-muted">正在检查…</p>}
      {preview && (
        <div className="space-y-2 text-fg-soft">
          {preview.canvas_files > 0 && (
            <p>
              其中 {preview.canvas_files} 个文件来自 Canvas：之后同步时不会再下载。需要时可以打开“显示已删除的文件”，右键恢复。
            </p>
          )}
          {preview.own_files > 0 && <p>你自己的 {preview.own_files} 个文件会在{trashName}里。</p>}
          {preview.canvas_files === 0 && preview.own_files === 0 && <p>这里面没有文件。</p>}
          {preview.canvas_folders.length > 0 && (
            <label className="mt-3 flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={stopFolders} onChange={(e) => setStopFolders(e.target.checked)} />
              <span>
                以后 Canvas 在{preview.canvas_folders.length > 1 ? "这些" : "这个"}文件夹里新增的文件也不下载
                <span className="block text-xs text-muted">不勾选的话，下次同步时文件夹会带着新文件回来（已删除的文件不会）。</span>
              </span>
            </label>
          )}
        </div>
      )}
    </Dialog>
  );
}
