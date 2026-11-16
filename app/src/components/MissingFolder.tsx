// The sync folder isn't where it was (moved, renamed or deleted): sync into a folder anew (the
// same place, by default), or say where it went. The account stays signed in either way.
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import * as api from "../lib/api";
import { friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { Button } from "./Dialog";
import { LanguagePicker } from "./LanguagePicker";
import { VersionLine } from "./VersionLine";

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
    const p = await pick(t("Choose the Old Sync Folder"));
    if (p) void use(p, false);
  };
  const choose = async () => {
    const p = await pick(t("Choose a sync folder"));
    if (p) setTarget(p);
  };

  return (
    <div data-tauri-drag-region className="flex h-screen items-center justify-center overflow-y-auto bg-bg p-8 text-fg">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-xl font-semibold">{t("Sync Folder Not Found")}</h1>
        <p className="mb-5 text-sm text-muted">
          {t("The sync folder isn't where it was. It may have been moved, renamed or deleted:")}
          <code className="mt-1 block truncate text-xs" title={root}>{root}</code>
        </p>
        <div className="space-y-4 rounded-xl border border-line bg-panel p-5 text-sm">
          <div>
            <p className="mb-1 font-medium">{t("Start over")}</p>
            <p className="mb-2 text-xs text-muted">{t("Pick an empty folder. Choose the courses to sync, then they're downloaded from Canvas again.")}</p>
            <div className="flex gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-chip px-2.5 py-1.5" title={target}>{target}</code>
              <Button onClick={() => void choose()} disabled={busy}>{t("Choose…")}</Button>
              <Button primary onClick={() => void use(target, true)} disabled={busy || !target}>{t("Continue")}</Button>
            </div>
          </div>
          <div className="border-t border-line pt-4">
            <p className="mb-1 font-medium">{t("Moved the folder?")}</p>
            <p className="mb-2 text-xs text-muted">{t("Pick where it is now, and carry on with its files and settings.")}</p>
            <Button onClick={() => void find()} disabled={busy}>{t("Locate…")}</Button>
          </div>
          {error && <p className="text-danger">{error}</p>}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 text-xs text-muted">
          <VersionLine />
          <span>{t("Language")}</span>
          <LanguagePicker />
        </div>
      </div>
    </div>
  );
}
