import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { DeletePreview } from "../lib/api";
import { trashName } from "../lib/keys";
import { Button, Dialog } from "./Dialog";
import { t, tn } from "../lib/i18n";

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
      title={t("Move {label} to the {trash}?", { label, trash: trashName })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button danger autoFocus disabled={!preview || busy} onClick={go}>{t("Move to {trash}", { trash: trashName })}</Button>
        </>
      }
    >
      {error && <p className="text-danger">{error}</p>}
      {!preview && !error && <p className="text-muted">{t("Checking…")}</p>}
      {preview && (
        <div className="space-y-2 text-fg-soft">
          {preview.canvas_files > 0 && (
            <p>
              {tn("1 of them is from Canvas: syncing won't download it again. To get it back, open its folder, click the eye icon at the top right to show modifications, then right-click it.", "{n} of them are from Canvas: syncing won't download them again. To get them back, open their folder, click the eye icon at the top right to show modifications, then right-click them.", { n: preview.canvas_files })}
            </p>
          )}
          {preview.own_files > 0 && <p>{tn("1 file of your own goes to the {trash}.", "{n} files of your own go to the {trash}.", { n: preview.own_files, trash: trashName })}</p>}
          {preview.canvas_files === 0 && preview.own_files === 0 && <p>{t("There are no files in here.")}</p>}
          {preview.canvas_folders.length > 0 && (
            <label className="mt-3 flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={stopFolders} onChange={(e) => setStopFolders(e.target.checked)} />
              <span>
                {preview.canvas_folders.length > 1 ? t("Don't download files Canvas adds to these folders later, either") : t("Don't download files Canvas adds to this folder later, either")}
                <span className="block text-xs text-muted">{t("If unchecked, the folder comes back with any new files on the next sync (the deleted ones don't).")}</span>
              </span>
            </label>
          )}
        </div>
      )}
    </Dialog>
  );
}
