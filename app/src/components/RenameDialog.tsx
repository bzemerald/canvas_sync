import { useState } from "react";
import { Button, Dialog } from "./Dialog";
import { t } from "../lib/i18n";

/** Rename from the sidebar, where there's no room to edit in place. */
export function RenameDialog({ current, title, hint, onClose, onSubmit }: {
  current: string;
  title: string; // 重命名课程 / 重命名学期 / 重命名文件夹
  hint?: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  const ok = name.trim() !== "" && name.trim() !== current;
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button primary disabled={!ok} onClick={() => onSubmit(name.trim())}>{t("重命名")}</Button>
        </>
      }
    >
      <input
        autoFocus
        value={name}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && ok && onSubmit(name.trim())}
        className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent"
      />
      <p className="mt-2 text-xs text-muted">{hint ?? t("只改本地的名字，同步不受影响：Canvas 上这里的新文件和更新照常同步进来。")}</p>
    </Dialog>
  );
}
