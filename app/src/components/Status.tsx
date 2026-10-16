import type { Entry } from "../lib/api";

const LABEL: Record<string, { text: string; className: string; hint: string }> = {
  modified: { text: "已修改", className: "bg-warn-soft text-warn", hint: "你改过这个文件；同步不会覆盖你的修改" },
  moved: { text: "已移动", className: "bg-info-soft text-info", hint: "你把它从原来的位置移到了这里；下次同步会记住新位置" },
  missing: { text: "已删除", className: "bg-chip text-muted", hint: "你删除了它；下次同步时不会再下载" },
  ignored: { text: "已删除", className: "bg-chip text-muted", hint: "你删除了它，之后不再同步；可以恢复" },
  remote_deleted: { text: "Canvas 已删除", className: "bg-danger-soft text-danger", hint: "老师已经从 Canvas 删除了它；本地副本保留着" },
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
        : null;
  return color ? <span className={`size-2 rounded-full ${color}`} /> : null;
}
