import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import type { FileStatus, Scope } from "../lib/api";
import { Button, Dialog } from "./Dialog";
import { FileIcon } from "./FileIcon";
import { Pill } from "./Status";
import { pathTree, type TreeNode } from "../lib/tree";
import { trashName } from "../lib/keys";
import { t, tn } from "../lib/i18n";
import { titlesAlong } from "../lib/things";

const WHY: Record<string, string> = { modified: t("Restore@@file"), missing: t("Put back"), ignored: t("Put back") };
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
      title={t("Restore Canvas originals in {label}", { label })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{files?.length ? t("Cancel") : t("Close")}</Button>
          {!!files?.length && (
            <Button primary onClick={go} disabled={busy}>
              {tn("Restore 1 file", "Restore {n} files", { n: files.length })}
            </Button>
          )}
        </>
      }
    >
      {error && <p className="text-danger">{error}</p>}
      {!files && !error && <p className="text-muted">{t("Checking…")}</p>}
      {files?.length === 0 && <p className="text-fg-soft">{t("Nothing from Canvas here has been changed or deleted; there's nothing to restore.")}</p>}
      {!!files?.length && (
        <>
          <p className="mb-3 text-fg-soft">
            {t("These files go back to the version last downloaded from Canvas.")}
            {nEdited > 0 && <>{tn("The 1 file you edited goes to the {trash} first, in case you want it back.", "The {n} files you edited go to the {trash} first, in case you want them back.", { n: nEdited, trash: trashName })}</>}
          </p>
          <FileTree files={files} />
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
              <span className="min-w-0 flex-1 truncate" title={n.path}>{titlesAlong(n.path).slice(-n.name.split("/").length).join(" / ")}</span>
              {gone > 0 && <Pill icon={<Trash2 />} n={gone} label={tn("1 of them is put back", "{n} of them are put back", { n: gone })} className="bg-danger text-on-accent" />}
              {changed > 0 && <Pill icon={<Pencil />} n={changed} label={tn("1 of them is restored", "{n} of them are restored", { n: changed })} className="bg-warn text-on-accent" />}
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
