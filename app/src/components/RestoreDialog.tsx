import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import type { FileStatus, Scope } from "../lib/api";
import { Button, Dialog } from "./Dialog";
import { FileIcon } from "./FileIcon";
import { Pill } from "./Status";
import { pathTree, type TreeNode } from "../lib/tree";
import { fileManager, trashName } from "../lib/keys";
import { t } from "../lib/i18n";

const WHY: Record<string, string> = { modified: t("改回原版"), missing: t("重新放回"), ignored: t("重新放回") };
const edited = (f: FileStatus) => f.states.includes("modified");
const OPEN_ALL = 30; // up to this many files, the folders start open; more, they start folded

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

  const nEdited = files?.filter(edited).length ?? 0;
  return (
    <Dialog
      title={t("恢复 {label} 的 Canvas 原版", { label })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{files?.length ? t("取消") : t("关闭")}</Button>
          {!!files?.length && (
            <Button primary onClick={go} disabled={busy}>
              {t("恢复 {n} 个文件", { n: files.length })}
            </Button>
          )}
        </>
      }
    >
      {error && <p className="text-danger">{error}</p>}
      {!files && !error && <p className="text-muted">{t("正在检查…")}</p>}
      {files?.length === 0 && <p className="text-fg-soft">{t("这里没有你修改或删除过的 Canvas 文件，不需要恢复。")}</p>}
      {!!files?.length && (
        <>
          <p className="mb-3 text-fg-soft">
            {t("这些文件会变回上次从 Canvas 下载的版本。")}
            {nEdited > 0 && <>{t("你修改过的 {n} 个文件会先移到{trash}，需要时可以从那里找回。", { n: nEdited, trash: trashName })}</>}
          </p>
          <FileTree files={files} />
          <p className="mt-2 text-xs text-muted">{t("移动过的文件会留在你放的位置（{app}里的整理会被保留）。", { app: fileManager })}</p>
        </>
      )}
    </Dialog>
  );
}

/** The files, in their folders, which open and fold. A folder counts what in it is put back
 * (deleted) and changed back (edited), as the file list does; a file says which. */
function FileTree({ files }: { files: FileStatus[] }) {
  const nodes = useMemo(() => pathTree(files.filter((f) => f.path), (f) => f.path!), [files]);
  const [open, setOpen] = useState<Set<string>>(() => {
    const all = new Set<string>();
    const walk = (ns: TreeNode<FileStatus>[]) => ns.forEach((n) => n.kind === "dir" && (all.add(n.path), walk(n.children)));
    if (files.length <= OPEN_ALL) walk(nodes);
    return all;
  });
  const toggle = (path: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const rows: React.ReactNode[] = [];
  const walk = (ns: TreeNode<FileStatus>[], depth: number) => {
    for (const n of ns) {
      const pad = { paddingLeft: depth * 16 + 4 };
      if (n.kind === "dir") {
        const isOpen = open.has(n.path);
        const gone = n.leaves.filter((f) => !edited(f)).length;
        const changed = n.leaves.length - gone;
        rows.push(
          <li key={n.path} role="treeitem" aria-expanded={isOpen}>
            <button onClick={() => toggle(n.path)} style={pad} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-chip">
              {isOpen ? <ChevronDown className="size-3.5 shrink-0 text-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-muted" />}
              <FileIcon name={n.name} dir />
              <span className="min-w-0 flex-1 truncate" title={n.path}>{n.name.replaceAll("/", " / ")}</span>
              {gone > 0 && <Pill icon={<Trash2 />} n={gone} label={t("其中 {n} 个会重新放回", { n: gone })} className="bg-danger text-on-accent" />}
              {changed > 0 && <Pill icon={<Pencil />} n={changed} label={t("其中 {n} 个会改回原版", { n: changed })} className="bg-warn text-on-accent" />}
            </button>
          </li>,
        );
        if (isOpen) walk(n.children, depth + 1);
      } else {
        const f = n.item;
        rows.push(
          <li key={f.file_id} role="treeitem" style={pad} className="flex items-center gap-1.5 px-1 py-0.5">
            <span className="w-3.5 shrink-0" />
            <FileIcon name={n.name} />
            <span className="min-w-0 flex-1 truncate" title={f.path ?? ""}>{n.name}</span>
            <span className={`shrink-0 rounded px-1.5 py-px text-[11px] whitespace-nowrap ${edited(f) ? "bg-warn-soft text-warn" : "bg-danger-soft text-danger"}`}>
              {WHY[f.states.find((s) => WHY[s]) ?? ""] ?? ""}
            </span>
          </li>,
        );
      }
    }
  };
  walk(nodes, 0);
  return <ul role="tree" className="max-h-80 overflow-y-auto rounded-md border border-line p-1 text-xs">{rows}</ul>;
}
