import type { Entry } from "../lib/api";

const LABEL: Record<string, { text: string; className: string; hint: string }> = {
  modified: { text: "已修改", className: "bg-warn-soft text-warn", hint: "你改过这个文件；同步不会覆盖你的修改" },
  moved: { text: "已移动", className: "bg-info-soft text-info", hint: "你把它从原来的位置移到了这里；下次同步会记住新位置" },
  missing: { text: "已删除", className: "bg-chip text-muted", hint: "你删除了它；下次同步时不会再下载" },
  ignored: { text: "已删除", className: "bg-chip text-muted", hint: "你删除了它，之后不再同步；可以恢复" },
  remote_deleted: { text: "Canvas 已删除", className: "bg-danger-soft text-danger", hint: "老师已经从 Canvas 删除了它；本地副本保留着" },
  untracked: { text: "不再同步", className: "bg-chip text-muted", hint: "你停止了同步：它现在是你自己的文件，Canvas 上的更新不会覆盖它" },
};

/** Badges for what changed. A file from Canvas that nobody touched shows nothing. */
export function StatusBadges({ entry }: { entry: Entry }) {
  const states = [...new Set(entry.states.map((s) => (s === "missing" ? "ignored" : s)))];
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
        <span title="你删除或停止同步了这个文件夹：Canvas 以后在这里新增的文件不会下载" className="rounded bg-chip px-1.5 py-px text-[11px] whitespace-nowrap text-muted">
          不再同步
        </span>
      )}
      {entry.new === "updated" && (
        <span title="Canvas 上有新版本，已经更新到这里；你还没打开过" className="rounded bg-info-soft px-1.5 py-px text-[11px] whitespace-nowrap text-info">
          已更新
        </span>
      )}
      {entry.type === "dir" && entry.new_inside > 0 && (
        <span title="里面有你还没打开过的新文件" className="rounded bg-selected px-1.5 py-px text-[11px] whitespace-nowrap text-accent">
          {entry.new_inside} 个新文件
        </span>
      )}
      {entry.type === "dir" && entry.changes > 0 && (
        <span title="里面有你改过或删除的文件" className="rounded bg-warn-soft px-1.5 py-px text-[11px] whitespace-nowrap text-warn">
          {entry.changes} 处改动
        </span>
      )}
    </span>
  );
}

/** A small dot for the icon view, where there's no room for words. */
export function StatusDot({ entry }: { entry: Entry }) {
  const s = entry.states;
  const color = s.includes("modified") || entry.changes > 0
    ? "bg-warn"
    : s.includes("remote_deleted")
      ? "bg-danger"
      : s.includes("moved")
        ? "bg-info"
        : entry.new || entry.new_inside > 0
          ? "bg-accent"
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
export function NewDot({ label = "新的" }: { label?: string }) {
  return <span title={label} aria-label={label} className="size-1.5 shrink-0 rounded-full bg-accent" />;
}
