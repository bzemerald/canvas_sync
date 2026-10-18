import { useEffect, useState } from "react";
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
// What Canvas did, shown always; the rest is what you did, shown only with 显示改动.
const NOT_YOURS = new Set(["remote_deleted"]);

/** Badges for what changed. A file from Canvas that nobody touched shows nothing; what you
 * changed shows only when `showChanges`. */
export function StatusBadges({ entry, showChanges }: { entry: Entry; showChanges: boolean }) {
  const states = [...new Set(entry.states.map((s) => (s === "missing" ? "ignored" : s)))]
    .filter((s) => showChanges || NOT_YOURS.has(s));
  return (
    <span className="flex gap-1">
      {states.map((s) =>
        LABEL[s] ? (
          <span key={s} title={LABEL[s].hint} className={`rounded px-1.5 py-px text-[11px] whitespace-nowrap ${LABEL[s].className}`}>
            {LABEL[s].text}
          </span>
        ) : null,
      )}
      {showChanges && entry.type === "dir" && entry.skipped && (
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
          {t("{n} 个新文件", { n: entry.new_inside })}
        </span>
      )}
      {showChanges && entry.type === "dir" && entry.deleted_inside > 0 && (
        <span title={t("里面有你删除的文件")} className="rounded bg-danger-soft px-1.5 py-px text-[11px] whitespace-nowrap text-danger">
          {t("{n} 个已删除", { n: entry.deleted_inside })}
        </span>
      )}
      {showChanges && entry.type === "dir" && entry.modified_inside > 0 && (
        <span title={t("里面有你改过的文件")} className="rounded bg-warn-soft px-1.5 py-px text-[11px] whitespace-nowrap text-warn">
          {t("{n} 个已修改", { n: entry.modified_inside })}
        </span>
      )}
    </span>
  );
}

/** A small dot for the icon view, where there's no room for words. */
export function StatusDot({ entry, showChanges }: { entry: Entry; showChanges: boolean }) {
  const s = entry.states;
  const color = s.includes("remote_deleted")
    ? "bg-danger"
    : entry.new || entry.new_inside > 0
      ? "bg-accent"
      : !showChanges
        ? null
        : s.includes("ignored") || s.includes("missing") || entry.deleted_inside > 0
          ? "bg-danger"
          : s.includes("modified") || entry.modified_inside > 0
            ? "bg-warn"
            : s.includes("moved")
              ? "bg-info"
              : null;
  return color ? <span className={`size-2 rounded-full ${color}`} /> : null;
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
