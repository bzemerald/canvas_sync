// The sidebar's pieces: 置顶's list, a term and its courses, a row, a section's header; the sync
// status at its top and the update notice at its foot. What they show and do is the main window's.
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import type { Course, SidebarOrder, SyncState } from "../lib/api";
import { shortDate } from "../lib/dates";
import { edSaying, fileSaying, syncSaying } from "../lib/errors";
import { locale, t } from "../lib/i18n";
import { moved, useReorder } from "../lib/reorder";
import { termRank } from "../lib/terms";
import { type Shown, thingKey } from "../lib/things";
import { installUpdate, useUpdate } from "../lib/update";
import { parentOf } from "./FileBrowser";
import { type Place, usePlaceDrag } from "./Place";
import { Count } from "./Status";

/** A term in the sidebar: `label` as you named it, `key` as Canvas does (what its place is saved by). */
export type TermGroup = { label: string; key: string; courses: Course[] };

export function groupByTerm(list: Course[]): TermGroup[] {
  const groups = new Map<string, Course[]>();
  for (const c of list) {
    const key = c.term ?? "";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => termRank(b) - termRank(a))
    .map(([key, courses]) => ({ key, courses, label: courses[0].term_label ?? t("无学期") }));
}

/** The sidebar's terms and courses as you dragged them. Terms you haven't placed (a new one)
 * come first, newest first; courses you haven't placed come last in their term. */
export function arrange(list: Course[], order: SidebarOrder): TermGroup[] {
  const place = <T,>(saved: T[], k: T, unplaced: number) => (saved.includes(k) ? saved.indexOf(k) : unplaced);
  return groupByTerm(list)
    .map(({ label, key, courses }, i) => ({
      label,
      key,
      i,
      courses: courses
        .map((c, j) => ({ c, j }))
        .sort((a, b) => place(order.courses, a.c.id, Infinity) - place(order.courses, b.c.id, Infinity) || a.j - b.j)
        .map(({ c }) => c),
    }))
    .sort((a, b) => place(order.terms, a.key, -1) - place(order.terms, b.key, -1) || a.i - b.i)
    .map(({ label, key, courses }) => ({ label, key, courses }));
}

/** 置顶: what's pinned, in the order you put it in. Anything dropped on it is pinned where you let
 * go (a line shows where); dragged off it, it's unpinned. */
export function PinnedSection({ place, collapsed, header, empty, render, onPin, onUnpin }: {
  place: Place; // 置顶
  collapsed: boolean;
  header: React.ReactNode;
  empty: React.ReactNode;
  render: (item: Shown) => React.ReactNode;
  onPin: (entry: Shown, at?: number) => void;
  onUnpin: (item: Shown) => void; // dragged off the list
}) {
  const items = place.entries;
  const list = useRef<HTMLDivElement>(null);
  const slotAt = (_x: number, y: number) => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>(":scope > [data-pin]") ?? []);
    const i = rows.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return i < 0 ? rows.length : i;
  };
  // (What's pinned can be dragged onto a course's tabs, its overview, too.)
  const { zone, drag } = usePlaceDrag(place, "y", { slotAt, drop: (entry, at) => onPin(entry, collapsed ? undefined : at), off: onUnpin });
  const over = zone.state === "over" && !collapsed && items.length > 0;
  const line = (
    <div aria-hidden className="relative h-0">
      <div className="absolute inset-x-2 -top-px h-0.5 rounded-full bg-accent" />
    </div>
  );
  return (
    <div
      ref={zone.ref}
      className={`-mx-1 rounded-lg px-1 pb-1 ${zone.state === "over" ? "bg-accent/10 ring-1 ring-accent" : zone.state === "ready" ? "outline-1 outline-dashed outline-accent/60" : ""}`}
    >
      {header}
      {!collapsed && items.length === 0 && (
        // Both in one spot, one shown: the sidebar below doesn't move as a drag starts (it'd be off
        // from where the pointer is, for dragging there).
        <div className="grid">
          <div className={`[grid-area:1/1] ${zone.state === "idle" ? "" : "invisible"}`}>{empty}</div>
          <p className={`[grid-area:1/1] self-center px-2 py-2 text-xs text-muted ${zone.state === "idle" ? "invisible" : ""}`}>{t("放在这里置顶")}</p>
        </div>
      )}
      {!collapsed && (
        <div ref={list}>
          {items.map((item, i) => (
            <Fragment key={thingKey(item)}>
              {over && zone.slot === i && line}
              <div data-pin {...drag.item(i)}>{render(item)}</div>
            </Fragment>
          ))}
          {over && zone.slot === items.length && line}
        </div>
      )}
    </div>
  );
}

/** A term in the sidebar: its header folds it and drags it among the terms; its courses drag
 * among themselves. */
export function TermSection({ group, sectionRef, grab, collapsed, editor, onToggle, onMenu, onReorder, renderCourse }: {
  group: TermGroup;
  editor?: React.ReactNode; // being renamed: the input, in its name's place
  sectionRef: (el: HTMLElement | null) => void;
  grab: { onPointerDown: (e: React.PointerEvent) => void };
  collapsed: boolean;
  onToggle: () => void;
  onMenu: (x: number, y: number) => void;
  onReorder: (ids: number[]) => void;
  renderCourse: (c: Course) => React.ReactNode;
}) {
  const drag = useReorder(group.courses.length, (from, to) => onReorder(moved(group.courses, from, to).map((c) => c.id)), "y", {
    thing: (i) => ({ type: "course", course: group.courses[i].id }),
  });
  const fresh = group.courses.reduce((n, c) => n + c.new, 0);
  return (
    <section ref={sectionRef}>
      <SectionHeader
        title={group.label}
        editor={editor}
        collapsed={collapsed}
        onToggle={onToggle}
        grab={grab}
        count={collapsed ? fresh : 0}
        action={{ label: t("{term} 的操作", { term: group.label }), icon: <MoreHorizontal className="size-3.5" />, onClick: onMenu }}
        onMenu={onMenu}
      />
      {!collapsed && group.courses.map((c, i) => (
        <div key={c.id} {...drag.item(i)}>
          {renderCourse(c)}
        </div>
      ))}
    </section>
  );
}

/** Where a pinned folder or file is, for its subtitle: its course (or term), else its parent folder. */
export function pinnedWhere(path: string, c: Course | null): string {
  if (c && path === c.dir) return c.term_label ?? "";
  if (c) return c.label;
  return parentOf(path) || t("全部文件");
}

export function NavItem({ icon, title, editor, subtitle, keys, active, count, muted, onPress, onClick, onMenu }: {
  icon?: React.ReactNode;
  title: string;
  editor?: React.ReactNode; // being renamed: the input, in its name's place (not in a button)
  subtitle?: string;
  keys?: string; // its shortcut, shown on the right
  active: boolean;
  muted?: boolean;
  count?: number; // new things in it
  onPress?: () => void;
  onClick: () => void;
  onMenu?: (x: number, y: number) => void;
}) {
  if (editor) {
    return (
      <div className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${active ? "bg-selected text-fg" : "text-fg-soft"} ${muted ? "opacity-50" : ""}`}>
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
        <span className="min-w-0 flex-1">
          {editor}
          {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
        </span>
      </div>
    );
  }
  return (
    <div className="group relative">
      <button
        onPointerDown={onPress}
        onClick={onClick}
        onContextMenu={onMenu && ((e) => (e.preventDefault(), onMenu(e.clientX, e.clientY)))}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${active ? "bg-selected text-fg" : "text-fg-soft hover:bg-chip"} ${muted ? "opacity-50" : ""}`}
      >
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{title}</span>
          {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
        </span>
        {keys && <span className="shrink-0 text-xs text-muted">{keys}</span>}
        {!!count && <span className="group-hover:hidden"><Count n={count} label={t("{n} 个新的", { n: count })} /></span>}
      </button>
      {onMenu && (
        <button
          aria-label={t("{title} 的操作", { title })}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.left, r.bottom + 2);
          }}
          className="absolute top-1/2 right-1 hidden -translate-y-1/2 rounded p-1 text-muted group-hover:block hover:bg-line hover:text-fg"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function SectionHeader({ title, editor, action, onMenu, collapsed, onToggle, grab, count = 0 }: {
  title: string;
  editor?: React.ReactNode; // being renamed: the input, in its name's place
  action?: { label: string; icon: React.ReactNode; onClick: (x: number, y: number) => void };
  onMenu?: (x: number, y: number) => void;
  collapsed?: boolean;
  onToggle?: () => void; // folds the section
  grab?: { onPointerDown: (e: React.PointerEvent) => void }; // drags the section
  count?: number; // new things inside, shown while it's folded
}) {
  return (
    <div
      {...grab}
      className="group mt-4 flex items-center gap-1 px-2 pb-1"
      onContextMenu={onMenu && !editor ? (e) => (e.preventDefault(), onMenu(e.clientX, e.clientY)) : undefined} // (the input's own: paste)
    >
      <h2 className="min-w-0 flex-1">
        {editor ?? <button
          onClick={onToggle}
          disabled={!onToggle}
          aria-expanded={onToggle ? !collapsed : undefined}
          title={onToggle ? (collapsed ? t("展开") : t("收起")) : undefined}
          className="flex max-w-full items-center gap-1 text-[11px] font-medium tracking-wide text-muted uppercase hover:text-fg-soft disabled:hover:text-muted"
        >
          <span className="truncate">{title}</span>
          {onToggle && (
            <ChevronRight className={`size-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90 opacity-0 group-hover:opacity-100"}`} />
          )}
        </button>}
      </h2>
      {/* What's new in a folded section; on hover, its actions take the place. They share one cell,
          so the row's height never changes: under the pointer that would make it flicker. */}
      <div className="grid items-center justify-items-end empty:hidden">
        {action && !editor && (
          <button
            title={action.label}
            aria-label={action.label}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              action.onClick(r.left, r.bottom + 2);
            }}
            className="peer col-start-1 row-start-1 rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-chip hover:text-fg focus-visible:opacity-100"
          >
            {action.icon}
          </button>
        )}
        {count > 0 && (
          <span className="col-start-1 row-start-1 flex group-hover:invisible peer-focus-visible:invisible">
            <Count n={count} label={t("{n} 个新的", { n: count })} />
          </span>
        )}
      </div>
    </div>
  );
}

const PHASE: Record<SyncState["phase"], string> = {
  idle: "",
  checking: t("正在检查 Canvas…"),
  downloading: t("正在下载"),
  indexing: t("正在建立搜索索引"),
  done: t("已同步"),
  failed: t("同步失败"),
};

const CHANGE: Record<string, (n: number) => string> = {
  download: (n) => t("{n} 个新文件", { n }),
  update: (n) => t("{n} 个更新", { n }),
  conflict: (n) => t("{n} 个冲突", { n }),
  move: (n) => t("移动了 {n} 个", { n }),
  ignore: (n) => t("{n} 个不再同步", { n }),
  remote_deleted: (n) => t("{n} 个已从 Canvas 删除", { n }),
  delete: (n) => t("删除了 {n} 个", { n }),
};

/** A new version, at the sidebar's foot once a check found one: click to update (and restart). */
export function UpdateNotice() {
  const update = useUpdate();
  if (update.phase !== "available" && update.phase !== "downloading" && update.phase !== "installing") return null;
  const label = update.phase === "available" ? t("新版本 {v} · 更新并重启", { v: update.version })
    : update.phase === "downloading" ? t("正在下载 {v}…", { v: update.version }) + (update.progress === null ? "" : ` ${Math.round(update.progress * 100)}%`)
      : t("正在安装，马上重启…");
  return (
    <button onClick={() => void installUpdate()} disabled={update.phase !== "available"}
      className="mb-1 w-full rounded-md bg-selected px-2.5 py-1.5 text-left text-xs text-accent hover:opacity-90 disabled:opacity-80">
      {label}
    </button>
  );
}

export function SyncStatus({ sync, label, onFix, onSignIn, session, renewing }: {
  sync: SyncState | null;
  label: string;
  onFix: () => void;
  onSignIn: () => void; // signed out of Canvas: sign in again
  session: boolean; // signed in in the Canvas window (else with a token)
  renewing?: boolean; // that, quietly, now
}) {
  const [showFailed, setShowFailed] = useState(false);
  if (!sync || sync.phase === "idle") return null;
  const failed = sync.failed ?? [];
  const pct = sync.total ? Math.round((sync.done / sync.total) * 100) : null;
  const finished = sync.finished_at ?? sync.last_synced; // when it ended
  const changes = Object.entries(sync.changes).map(([k, n]) => CHANGE[k]?.(n) ?? `${n} ${k}`).join(t("，"));
  return (
    <div className="mx-4 mb-2 rounded-md bg-chip px-2.5 py-2 text-xs text-fg-soft">
      <div className="flex justify-between gap-2">
        <span className={`truncate ${sync.phase === "failed" ? "text-danger" : ""}`}>
          {PHASE[sync.phase]}{label && sync.scope.length > 0 ? ` · ${label}` : ""}
        </span>
        {sync.running && pct !== null && <span className="shrink-0">{sync.done}/{sync.total}</span>}
        {!sync.running && finished && <span className="shrink-0 text-muted" title={new Date(finished).toLocaleString(locale)}>{shortDate(finished)}</span>}
      </div>
      {sync.running && pct !== null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {sync.running && sync.current && <p className="mt-1 truncate text-muted">{sync.current.split("/").pop()}</p>}
      {sync.phase === "done" && <p className="mt-0.5 text-muted">{changes || t("没有新内容")}</p>}
      {!sync.expired && sync.errors.slice(0, 1).map((e) => (
        <p key={e} className="mt-1 break-words text-danger" title={e}>{syncSaying(e)}</p>
      ))}
      {failed.length > 0 && (
        <button onClick={() => setShowFailed(!showFailed)} className="mt-1 block text-left text-danger hover:underline">
          {t("{n} 个文件没能同步", { n: failed.length })}{showFailed ? " ▾" : " ›"}
        </button>
      )}
      {showFailed && (
        <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
          {failed.map((f) => (
            <li key={f.path} title={`${f.path}\n${f.error}`}>
              <span className="block truncate">{f.path.split("/").pop()}</span>
              <span className="block text-muted">{fileSaying(f.error)}</span>
            </li>
          ))}
        </ul>
      )}
      {!sync.running && sync.warnings.length > 0 && (
        <p className="mt-1 text-muted" title={sync.warnings.join("\n")}>{t("有些内容这次没读到，下次同步再试。")}</p>
      )}
      {sync.expired && (renewing ? (
        <p className="mt-1 text-muted">{t("正在重新登录 Canvas…")}</p>
      ) : (
        <button onClick={onSignIn} className="mt-1 block text-left text-accent hover:underline">
          {session ? t("Canvas 登录已过期，点这里重新登录") : t("Canvas 令牌已失效，点这里更换")}
        </button>
      ))}
      {!sync.running && sync.ed_error && (
        <button onClick={onFix} className="mt-1 block text-left text-danger hover:underline">{t("Ed：{why}", { why: edSaying(sync.ed_error) })}</button>
      )}
    </div>
  );
}
