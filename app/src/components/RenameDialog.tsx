import { useState } from "react";
import { Button, Dialog } from "./Dialog";

/** Rename from the sidebar, where there's no room to edit in place. */
export function RenameDialog({ current, what, onClose, onSubmit }: {
  current: string;
  what: string; // e.g. "课程文件夹"
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  const ok = name.trim() !== "" && name.trim() !== current;
  return (
    <Dialog
      title={`重命名${what}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button primary disabled={!ok} onClick={() => onSubmit(name.trim())}>重命名</Button>
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
      <p className="mt-2 text-xs text-muted">只改本地文件夹的名字。以后 Canvas 上这里的新文件和更新，仍然会同步到这个文件夹里。</p>
    </Dialog>
  );
}
