// The sync folder isn't where it was (moved, renamed or deleted): sync into a folder anew (the
// same place, by default), or say where it went. The account stays signed in either way.
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import * as api from "../lib/api";
import { friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { Button } from "./Dialog";
import { LanguagePicker } from "./LanguagePicker";

export function MissingFolderPage({ root, onDone }: { root: string; onDone: () => void }) {
  const [target, setTarget] = useState(root);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (title: string) => open({ directory: true, title }).then((p) => (typeof p === "string" ? p : null));
  const use = async (path: string, isNew: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.moveFolder(path, isNew);
      onDone();
    } catch (e) {
      setError(friendly((e as Error).message));
      setBusy(false);
    }
  };
  const find = async () => {
    const p = await pick(t("选择原来的同步文件夹"));
    if (p) void use(p, false);
  };
  const choose = async () => {
    const p = await pick(t("选择同步文件夹"));
    if (p) setTarget(p);
  };

  return (
    <div data-tauri-drag-region className="flex h-screen items-center justify-center overflow-y-auto bg-bg p-8 text-fg">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-xl font-semibold">{t("找不到同步文件夹")}</h1>
        <p className="mb-5 text-sm text-muted">
          {t("原来的同步文件夹不在了，可能被移动、改名或删除了：")}
          <code className="mt-1 block truncate text-xs" title={root}>{root}</code>
        </p>
        <div className="space-y-4 rounded-xl border border-line bg-panel p-5 text-sm">
          <div>
            <p className="mb-1 font-medium">{t("重新同步到一个文件夹")}</p>
            <p className="mb-2 text-xs text-muted">{t("选一个空文件夹（或者就用原来的位置），先选要同步的课程，再从 Canvas 重新下载。")}</p>
            <div className="flex gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-chip px-2.5 py-1.5" title={target}>{target}</code>
              <Button onClick={() => void choose()} disabled={busy}>{t("选择…")}</Button>
              <Button primary onClick={() => void use(target, true)} disabled={busy || !target}>{t("继续")}</Button>
            </div>
          </div>
          <div className="border-t border-line pt-4">
            <p className="mb-1 font-medium">{t("文件夹被移到了别处？")}</p>
            <p className="mb-2 text-xs text-muted">{t("选它现在的位置，下载过的文件、置顶和设置都接着用。")}</p>
            <Button onClick={() => void find()} disabled={busy}>{t("找到它…")}</Button>
          </div>
          {error && <p className="text-danger">{error}</p>}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 text-xs text-muted">
          <span>{t("语言")}</span>
          <LanguagePicker />
        </div>
      </div>
    </div>
  );
}
