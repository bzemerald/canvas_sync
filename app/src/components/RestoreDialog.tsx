import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { FileStatus, Scope } from "../lib/api";
import { Button, Dialog } from "./Dialog";
import { fileManager, isMac } from "./Result";

const WHY: Record<string, string> = { modified: "改回原版", missing: "重新放回", ignored: "重新放回" };
const trash = isMac ? "废纸篓" : "回收站";

/** Shows exactly which files a restore would touch, then does it. */
export function RestoreDialog({ scope, label, onClose, onDone }: {
  scope: Scope;
  label: string;
  onClose: () => void;
  onDone: (restored: string[]) => void;
}) {
  const [files, setFiles] = useState<FileStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.restorePreview(scope).then((r) => setFiles(r.files), (e) => setError(e.message));
  }, [scope]);

  const go = async () => {
    setBusy(true);
    try {
      onDone((await api.restore(scope)).restored);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const edited = files?.filter((f) => f.states.includes("modified")).length ?? 0;
  return (
    <Dialog
      title={`恢复 ${label} 的 Canvas 原版`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{files?.length ? "取消" : "关闭"}</Button>
          {!!files?.length && (
            <Button primary onClick={go} disabled={busy}>
              恢复 {files.length} 个文件
            </Button>
          )}
        </>
      }
    >
      {error && <p className="text-danger">{error}</p>}
      {!files && !error && <p className="text-muted">正在检查…</p>}
      {files?.length === 0 && <p className="text-fg-soft">这里没有你修改或删除过的 Canvas 文件，不需要恢复。</p>}
      {!!files?.length && (
        <>
          <p className="mb-3 text-fg-soft">
            这些文件会变回上次从 Canvas 下载的版本。
            {edited > 0 && <>你修改过的 {edited} 个文件会先移到{trash}，需要时可以从那里找回。</>}
          </p>
          <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-line p-2 text-xs">
            {files.map((f) => (
              <li key={f.file_id} className="flex gap-3">
                <span className="w-14 shrink-0 text-muted">{WHY[f.states.find((s) => WHY[s]) ?? ""] ?? ""}</span>
                <span className="min-w-0 truncate" title={f.path ?? ""}>{f.path}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">移动过的文件会留在你放的位置（{fileManager}里的整理会被保留）。</p>
        </>
      )}
    </Dialog>
  );
}
