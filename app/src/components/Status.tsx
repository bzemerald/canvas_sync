import { useEffect, useState } from "react";
import { CloudOff, FolderInput, Pencil, Trash2 } from "lucide-react";
import type { Entry } from "../lib/api";
import { t } from "../lib/i18n";

const LABEL: Record<string, { text: string; className: string; hint: string }> = {
  modified: { text: t("已修改"), className: "bg-warn-soft text-warn", hint: t("你改过这个文件；同步不会覆盖你的修改") },
  moved: { text: t("已移动"), className: "bg-info-soft text-info", hint: t("你把它从原来的位置移到了这里；下次同步会记住新位置") },
  missing: { text: t("已删除"), className: "bg-danger-soft text-danger", hint: t("你删除了它；下次同步时不会再下载") },
  ignored: { text: t("已删除"), className: "bg-danger-soft text-danger", hint: t("你删除了它，之后不再同步；可以恢复") },
  remote_deleted: { text: t("Canvas 已删除"), className: "bg-danger-soft text-danger", hint: t("老师已经从 Canvas 删除了它；本地副本保留着") },
  untracked: { text: t("不再同步"), className: "bg-chip text-muted", hint: t("你停止了同步：它现在是你自己的文件，Canvas 上的更新不会覆盖它") },
};
// Shown always: what Canvas did, and what isn't synced (that's how it is now, not a change to
// undo). The rest is what you did, shown only with 显示改动.
const ALWAYS = new Set(["remote_deleted", "untracked"]);

/** Badges for what changed. A file from Canvas that nobody touched shows nothing; what you
 * changed shows only when `showChanges` (but 不再同步 always). */
export function StatusBadges({ entry, showChanges }: { entry: Entry; showChanges: boolean }) {
  const states = [...new Set(entry.states.map((s) => (s === "missing" ? "ignored" : s)))]
    .filter((s) => showChanges || ALWAYS.has(s));
  return (
    <span className="flex gap-1">
      {states.map((s) =>
        LABEL[s] ? (
          <span key={s} title={LABEL[s].hint} className={`rounded px-1.5 py-px text-[11px] whitespace-nowrap ${LABEL[s].className}`}>
            {LABEL[s].text}
          </span>
        ) : null,
      )}
      {entry.type === "dir" && entry.skipped && (
        <span title={t("你删除或停止同步了这个文件夹：Canvas 以后在这里新增的文件不会下载")} className="rounded bg-chip px-1.5 py-px text-[11px] whitespace-nowrap text-muted">
          {t("不再同步")}
        </span>
      )}
      {entry.new === "updated" && (
        <span title={t("Canvas 上有新版本，已经更新到这里；你还没打开过")} className="rounded bg-info-soft px-1.5 py-px text-[11px] whitespace-nowrap text-info">
          {t("已更新")}
        </span>
      )}
      {entry.type === "dir" && entry.new_inside > 0 && (
        <span title={t("里面有你还没打开过的新文件")} className="rounded bg-selected px-1.5 py-px text-[11px] whitespace-nowrap text-accent">
          {t("{n} 个未读", { n: entry.new_inside })}
        </span>
      )}
      {showChanges && <Tallies entry={entry} />}
    </span>
  );
}

/** A folder's count of what you deleted and changed below it: an icon and a number, small
 * enough to sit beside its other badges (the words are in the tooltip). */
function Tallies({ entry }: { entry: Entry }) {
  if (entry.type !== "dir") return null;
  return (
    <>
      {entry.deleted_inside > 0 && (
        <Pill icon={<Trash2 />} n={entry.deleted_inside} label={t("里面有 {n} 个你删除的文件", { n: entry.deleted_inside })} className="bg-danger text-on-accent" />
      )}
      {entry.modified_inside > 0 && (
        <Pill icon={<Pencil />} n={entry.modified_inside} label={t("里面有 {n} 个你改过的文件", { n: entry.modified_inside })} className="bg-warn text-on-accent" />
      )}
    </>
  );
}

export function Pill({ icon, n, label, className }: { icon?: React.ReactNode; n?: number; label: string; className: string }) {
  return (
    <span title={label} aria-label={label} className={`flex h-4 min-w-4 shrink-0 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] leading-none font-medium tabular-nums whitespace-nowrap [&>svg]:size-2.5 ${className}`}>
      {icon}
      {n !== undefined && (n > 99 ? "99+" : n)}
    </span>
  );
}

/** The icon view's marks, on the icon's corner: a folder's counts (new, and with `showChanges`
 * what you deleted and changed); a file's state as an icon. Hover says what each is. */
export function IconMarks({ entry, showChanges }: { entry: Entry; showChanges: boolean }) {
  const s = entry.states;
  const mine = (x: string) => showChanges && s.includes(x);
  const marks = entry.type === "dir" ? (
    <>
      {entry.new_inside > 0 && <Count n={entry.new_inside} label={t("里面有你还没打开过的新文件")} />}
      {showChanges && <Tallies entry={entry} />}
    </>
  ) : (
    <>
      {entry.new && <Pill label={entry.new === "updated" ? t("有新版本，你还没打开过") : t("新文件，你还没打开过")} className="bg-accent text-on-accent" />}
      {s.includes("remote_deleted") && <Pill icon={<CloudOff />} label={LABEL.remote_deleted.hint} className="bg-danger text-on-accent" />}
      {(mine("missing") || mine("ignored")) && <Pill icon={<Trash2 />} label={LABEL.ignored.hint} className="bg-danger text-on-accent" />}
      {mine("modified") && <Pill icon={<Pencil />} label={LABEL.modified.hint} className="bg-warn text-on-accent" />}
      {mine("moved") && <Pill icon={<FolderInput />} label={LABEL.moved.hint} className="bg-info text-on-accent" />}
    </>
  );
  return <span className="absolute -top-1 -right-1 flex gap-0.5 [&>*]:ring-2 [&>*]:ring-bg">{marks}</span>;
}

/** How many new things there are. */
export function Count({ n, label }: { n: number; label: string }) {
  return (
    <span title={label} aria-label={label} className="min-w-4 shrink-0 rounded-full bg-accent px-1.5 text-center text-[10px] leading-4 font-medium text-on-accent">
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** Marks one new thing: arrived since you last looked, and you haven't opened it. */
export function NewDot({ label = t("新的") }: { label?: string }) {
  return <span title={label} aria-label={label} className="size-1.5 shrink-0 rounded-full bg-accent" />;
}

/** 正在加载…, said only if it takes a while: usually the answer is in before anyone could read it,
 * and a flash of text would just make the page jump. It takes its place from the start. */
export function Loading({ className = "px-6 py-8 text-sm" }: { className?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(timer);
  }, []);
  return <p className={`${className} text-muted transition-opacity duration-200 ${slow ? "opacity-100" : "opacity-0"}`}>{t("正在加载…")}</p>;
}
