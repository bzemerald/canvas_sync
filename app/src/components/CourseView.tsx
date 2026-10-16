// A course's page: tabs (概览 first), the overview, and readers for announcements,
// assignments, pages, the syllabus and grades. The 文件 tab is the file browser, rendered
// by the main window. A blue dot marks what's new to you; opening it clears the dot.
import {
  AppWindow, BookOpen, Check, ChevronDown, ChevronRight, ClipboardList, ExternalLink, FileText, Folder, FolderOpen, Link, ListChecks, Lock,
  Megaphone, MessagesSquare, Paperclip, ScrollText,
} from "lucide-react";
import { createElement, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type {
  Course, DocKind, Grades, Item, ItemSummary, LaunchTarget, LayoutChanges, Module, ModuleItem, NewCounts, Overview, PinTarget, TabItem,
  Total,
} from "../lib/api";
import { PinsContext, pinMenuItem, usePinnable } from "../lib/pinnable";
import { usePinZone } from "../lib/pinZone";
import { RenameDialog } from "./RenameDialog";
import { usePref } from "../lib/prefs";
import { useSearch } from "../lib/useSearch";
import { shortDate, untilDue } from "../lib/dates";
import { moved, useReorder } from "../lib/reorder";
import { FileIcon } from "./FileIcon";
import type { MenuItem } from "./Menu";
import { Count, NewDot } from "./Status";
import { RichText, type CourseLink } from "./RichText";
import { t } from "../lib/i18n";

export type CourseTab = "overview" | "modules" | "announcements" | "assignments" | "grades" | "files" | "syllabus" | "pages";
/** A tab: built in, or one you added ("x:" and its id). */
export type TabKey = CourseTab | `x:${string}`;
export const isAddedTab = (k: string): k is `x:${string}` => k.startsWith("x:");
/** Tabs you added that open elsewhere (a file in its app, a tool or link in the browser), not in the tab. */
export const OPENS_ELSEWHERE: TabItem["type"][] = ["file", "tool", "link"];

export const TAB_OF_KIND: Record<DocKind, CourseTab> = {
  announcement: "announcements", assignment: "assignments", page: "pages", syllabus: "syllabus",
};
const KIND_OF_TAB: Partial<Record<CourseTab, DocKind>> = {
  announcements: "announcement", assignments: "assignment", pages: "page", syllabus: "syllabus",
};

/** The overview, loaded once per course and version (it also says which tabs to show).
 * `seen` changes when you open something, so the counts of what's new follow. */
export function useOverview(courseId: number | null, version: number, seen: number) {
  const [data, setData] = useState<{ id: number; overview: Overview } | null>(null);
  useEffect(() => {
    if (courseId === null) return;
    let live = true;
    api.overview(courseId).then((o) => live && setData({ id: courseId, overview: o }), () => {});
    return () => {
      live = false;
    };
  }, [courseId, version, seen]);
  return data && data.id === courseId ? data.overview : null;
}

/** Open external tools; `pending` is the one on its way (asking Canvas for a link takes a moment). */
export function useLaunch(courseId: number) {
  const [pending, setPending] = useState<string | null>(null);
  const launch = (key: string, target: LaunchTarget) => {
    setPending(key);
    void api.launch(courseId, target).catch(() => {}).finally(() => setPending((p) => (p === key ? null : p)));
  };
  return { launch, pending };
}

export const totalNew = (n: NewCounts | undefined) => (n ? n.announcements + n.assignments + n.pages + n.files : 0);

export const DEFAULT_TABS: CourseTab[] = ["overview", "modules", "announcements", "assignments", "grades", "files", "syllabus", "pages"];

export const TAB_LABEL: Record<CourseTab, string> = {
  overview: t("概览"), modules: t("模块"), announcements: t("公告"), assignments: t("作业"), grades: t("成绩"),
  files: t("文件"), syllabus: t("大纲"), pages: t("页面"),
};

/** Every tab, in the order you dragged them into (built-in ones you never placed go at the end,
 * then tabs you added that aren't placed). */
export function arrangeTabs(saved: string[], items: TabItem[] = []): TabKey[] {
  const added = items.map((i): TabKey => `x:${i.id}`);
  const placed = saved.filter((x): x is TabKey => (DEFAULT_TABS as string[]).includes(x) || added.includes(x as TabKey));
  return [...placed, ...DEFAULT_TABS.filter((x) => !placed.includes(x)), ...added.filter((x) => !placed.includes(x))];
}

const under = (path: string, dir: string) => path === dir || path.startsWith(dir + "/");

/** Whether something dragged onto a course's tabs can be a tab there: what's in that course (not
 * the course itself), or a web link. */
function belongsTo(target: PinTarget, course: Course): boolean {
  if ("url" in target) return true;
  if ("file" in target) return under(target.file, course.dir);
  if ("path" in target) return target.path !== course.dir && under(target.path, course.dir);
  if ("kind" in target || "module" in target || "tool" in target) return target.course === course.id;
  return false;
}

const DOC_ICON: Record<DocKind, typeof Megaphone> = { announcement: Megaphone, assignment: ClipboardList, page: BookOpen, syllabus: ScrollText };

export const tabItemLabel = (i: TabItem) =>
  i.title || (i.path ? i.path.split("/").pop() ?? i.path : i.url ? i.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : "");

function TabItemIcon({ item }: { item: TabItem }) {
  if (item.type === "file") return <FileIcon name={item.path ?? ""} />;
  const icon = item.type === "doc" ? DOC_ICON[item.kind ?? "page"] : item.type === "folder" ? Folder : item.type === "module" ? ListChecks
    : item.type === "tool" ? AppWindow : Link;
  return createElement(icon, { className: "size-3.5 shrink-0" });
}

const newTabId = () => Math.random().toString(36).slice(2, 10);

/** `all` with the items of `subset` (in it) put back in the order of `reordered`; the rest stay put. */
export function refill<T>(all: T[], subset: T[], reordered: T[]): T[] {
  const queue = [...reordered];
  return all.map((x) => (subset.includes(x) ? queue.shift()! : x));
}

/** A course's tabs. Drag to reorder, right-click to hide. Tabs with nothing in them aren't
 * shown; 概览 and 文件 always are, unless you hid them. Drag something of the course (a page, a
 * folder, a module, a tool...) onto them and it's a tab too; drag one of those off, it's gone. */
export function CourseTabs({
  course, tab, overview, order, hidden, items, own, onTab, onOpenItem, onMarkAllSeen, onLayout, onReset, onMakeDefault, onMenu,
}: {
  course: Course;
  tab: TabKey;
  overview: Overview | null;
  order: TabKey[]; // every tab, built in and added, in order
  hidden: CourseTab[];
  items: TabItem[]; // the tabs you added
  own: boolean; // this course's tabs are arranged for itself
  onTab: (t: TabKey) => void;
  onOpenItem: (item: TabItem) => void; // a tab that opens elsewhere: a file, a tool, a link
  onMarkAllSeen: () => void;
  onLayout: (changes: LayoutChanges) => void; // for this course
  onReset: () => void; // back to how every course is
  onMakeDefault: () => void; // every course (not arranged for itself) like this one
  onMenu: (items: MenuItem[], x: number, y: number) => void;
}) {
  const pins = useContext(PinsContext);
  const bar = useRef<HTMLElement>(null);
  const [renaming, setRenaming] = useState<TabItem | null>(null);
  const c = overview?.counts;
  const n = overview?.new;
  const has: Record<CourseTab, boolean> = {
    overview: true, modules: !!c?.modules, announcements: !!c?.announcements, assignments: !!c?.assignments,
    grades: !!c?.grades, files: true, syllabus: !!c?.syllabus, pages: !!c?.pages,
  };
  const fresh: Partial<Record<CourseTab, number>> = {
    announcements: n?.announcements, assignments: n?.assignments, files: n?.files, pages: n?.pages,
  };
  const itemOf = (k: TabKey) => (isAddedTab(k) ? items.find((i) => `x:${i.id}` === k) ?? null : null);
  const visible = order.filter((k) => (isAddedTab(k) ? !!itemOf(k) : !hidden.includes(k) && (has[k] || k === tab)));
  const removeItem = (item: TabItem) => onLayout({ tab_items: items.filter((i) => i.id !== item.id) });

  // Dropped on the tabs: a tab of its own, where it was let go (already one: it moves there).
  const addTab = (target: PinTarget, slot: number) => {
    const existing = items.find((i) => api.pinKey(api.targetOfTab(i, course.id)) === api.pinKey(target));
    const item = existing ?? api.tabItemOf(target, newTabId());
    if (!item) return;
    const key: TabKey = `x:${item.id}`;
    const shown = visible.filter((k) => k !== key);
    const at = Math.min(slot - (visible.slice(0, slot).includes(key) ? 1 : 0), shown.length);
    const rest = order.filter((k) => k !== key);
    const next = shown[at];
    const place = next !== undefined ? rest.indexOf(next) : shown.length ? rest.indexOf(shown[shown.length - 1]) + 1 : 0;
    onLayout({ tab_items: existing ? items : [...items, item], tabs: [...rest.slice(0, place), key, ...rest.slice(place)] });
  };
  const slotAt = (x: number) => {
    const tabs = Array.from(bar.current?.querySelectorAll<HTMLElement>(":scope > [data-tab]") ?? []);
    const i = tabs.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    return i < 0 ? tabs.length : i;
  };
  const zone = usePinZone(addTab, (x) => slotAt(x), (target) => belongsTo(target, course));
  const drag = useReorder(visible.length, (from, to) => onLayout({ tabs: refill(order, visible, moved(visible, from, to)), hidden_tabs: hidden }), "x", {
    zone: zone.id,
    pin: (i) => {
      const item = itemOf(visible[i]);
      return item ? api.targetOfTab(item, course.id) : null; // (onto 置顶)
    },
    remove: (i) => {
      const item = itemOf(visible[i]);
      return item ? () => removeItem(item) : null;
    },
  });

  // Where a dropped thing would go: a line between two tabs.
  const markerLeft = (() => {
    if (zone.state !== "over" || !bar.current) return null;
    const tabs = Array.from(bar.current.querySelectorAll<HTMLElement>(":scope > [data-tab]"));
    if (!tabs.length) return null;
    const box = bar.current.getBoundingClientRect();
    const r = (tabs[zone.slot] ?? tabs[tabs.length - 1]).getBoundingClientRect();
    return (zone.slot < tabs.length ? r.left - 2 : r.right + 2) - box.left + bar.current.scrollLeft;
  })();

  const menu = (k: TabKey | null): MenuItem[] => {
    const item = k ? itemOf(k) : null;
    const showAgain: MenuItem[] = hidden.map((h) => ({
      label: t("显示“{name}”标签", { name: TAB_LABEL[h] }), onSelect: () => onLayout({ tabs: order, hidden_tabs: hidden.filter((x) => x !== h) }),
    }));
    const own_: MenuItem[] = item
      ? [
          ...(OPENS_ELSEWHERE.includes(item.type) ? [{ label: t("打开"), onSelect: () => onOpenItem(item) }] : []),
          ...(pins ? [pinMenuItem(pins, api.targetOfTab(item, course.id))] : []),
          { label: t("重命名…"), onSelect: () => setRenaming(item) },
          { label: t("移除这个标签"), onSelect: () => removeItem(item) },
        ]
      : k && !isAddedTab(k)
        ? [{
            label: t("隐藏“{name}”标签", { name: TAB_LABEL[k] }),
            disabled: visible.length <= 1,
            onSelect: () => onLayout({ tabs: order, hidden_tabs: [...hidden, k] }),
          }]
        : [];
    const list: MenuItem[] = [
      ...own_,
      ...(showAgain.length ? ["separator" as const, ...showAgain] : []),
      "separator",
      { label: t("设为所有课程的默认排列"), onSelect: onMakeDefault },
      { label: t("恢复默认（和其他课程一样）"), disabled: !own, onSelect: onReset },
    ];
    while (list[0] === "separator") list.shift(); // (no tab under the pointer: nothing to hide)
    return list;
  };

  return (
    <nav
      ref={bar}
      className={`no-scrollbar relative flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-4 ${
        zone.state === "over" ? "bg-accent/10" : zone.state === "ready" ? "outline-1 -outline-offset-2 outline-dashed outline-accent/60" : ""
      }`}
      aria-label={t("课程")}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onMenu(menu(null), e.clientX, e.clientY);
      }}
    >
      {visible.map((k, i) => {
        const item = itemOf(k);
        return (
          <button
            key={k}
            data-tab
            {...drag.item(i)}
            onClick={() => (item && OPENS_ELSEWHERE.includes(item.type) ? onOpenItem(item) : onTab(k))}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(menu(k), e.clientX, e.clientY);
            }}
            aria-current={tab === k ? "page" : undefined}
            title={item ? t("拖离标签栏可以移除") : undefined}
            className={`relative -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${tab === k ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
          >
            {item ? (
              <>
                <TabItemIcon item={item} />
                <span className="max-w-48 truncate">{tabItemLabel(item)}</span>
              </>
            ) : (
              <>
                {TAB_LABEL[k as CourseTab]}
                {!!fresh[k as CourseTab] && <Count n={fresh[k as CourseTab]!} label={t("{n} 个新的", { n: fresh[k as CourseTab]! })} />}
              </>
            )}
          </button>
        );
      })}
      {markerLeft !== null && (
        <span aria-hidden className="pointer-events-none absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" style={{ left: markerLeft - 1 }} />
      )}
      {totalNew(n) > 0 && (
        <button onClick={onMarkAllSeen} className="ml-auto shrink-0 py-2 text-xs text-muted hover:text-fg" title={t("清除这门课所有的“新”标记")}>
          {t("全部标为已读")}
        </button>
      )}
      {renaming && (
        <RenameDialog
          current={tabItemLabel(renaming)}
          title={t("重命名标签")}
          hint={t("只改这个标签的名字。")}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => {
            onLayout({ tab_items: items.map((i) => (i.id === renaming.id ? { ...i, title: name } : i)) });
            setRenaming(null);
          }}
        />
      )}
    </nav>
  );
}

// -- submissions and grades ----------------------------------------------------------------

export const fmt = (x: number) => String(Math.round(x * 100) / 100);

/** A grade the way the assignment is graded: "8.5 / 10", "A-", "通过". */
export function scoreText(a: ItemSummary): string | null {
  if (a.status !== "graded") return null;
  switch (a.grading_type) {
    case "pass_fail":
      return a.grade === "complete" ? t("通过") : a.grade === "incomplete" ? t("未通过") : a.grade ?? null;
    case "percent":
    case "letter_grade":
    case "gpa_scale":
      return a.grade ?? (a.score != null ? fmt(a.score) : null);
    default:
      if (a.score == null) return a.grade ?? null;
      return a.points ? `${fmt(a.score)} / ${fmt(a.points)}` : fmt(a.score);
  }
}

const STATUS: Record<string, { text: string; className: string; hint: string }> = {
  submitted: { text: t("已提交"), className: "bg-ok-soft text-ok", hint: t("已提交，还没有成绩（或成绩还没公布）") },
  missing: { text: t("缺交"), className: "bg-danger-soft text-danger", hint: t("已过截止时间，Canvas 上没有你的提交") },
  excused: { text: t("免交"), className: "bg-chip text-muted", hint: t("老师免除了这项作业") },
  unsubmitted: { text: t("未提交"), className: "bg-chip text-muted", hint: t("Canvas 上还没有你的提交") },
};

/** Handed in? Graded? `quiet`: say nothing about work that's simply not done yet. */
export function SubmissionBadges({ a, quiet = false }: { a: ItemSummary; quiet?: boolean }) {
  const score = scoreText(a);
  const s = a.status && a.status !== "graded" && !(quiet && a.status === "unsubmitted") ? STATUS[a.status] : null;
  return (
    <>
      {score && <span title={t("成绩")} className="rounded bg-ok-soft px-1.5 text-[11px] whitespace-nowrap text-ok tabular-nums">{score}</span>}
      {s && <span title={s.hint} className={`rounded px-1.5 text-[11px] whitespace-nowrap ${s.className}`}>{s.text}</span>}
      {a.late && <span title={t("提交时已过截止时间")} className="rounded bg-warn-soft px-1.5 text-[11px] whitespace-nowrap text-warn">{t("迟交")}</span>}
    </>
  );
}

export function TotalLine({ total, big = false }: { total: Total; big?: boolean }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className={`${big ? "text-3xl" : "text-xl"} font-semibold tabular-nums`}>{fmt(total.current_score)}%</span>
      {total.current_grade && <span className={`${big ? "text-lg" : "text-sm"} font-medium text-fg-soft`}>{total.current_grade}</span>}
    </span>
  );
}

// -- 概览 --------------------------------------------------------------------------------

/** A row in a card or list; `pin`: what it is, to drag onto 置顶 or right-click to pin. */
export function Row({ onClick, pin, children }: { onClick: () => void; pin?: PinTarget | null; children: React.ReactNode }) {
  const pinnable = usePinnable();
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === "Enter" && onClick()} {...pinnable(pin)}
      className="cursor-default rounded-md px-2 py-1.5 text-sm hover:bg-chip">
      {children}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-3 text-sm text-muted">{children}</p>;
}

function Due({ iso }: { iso: string | null | undefined }) {
  const due = untilDue(iso);
  if (!due) return <span className="text-xs text-muted">{t("没有截止日期")}</span>;
  return (
    <span className={`text-xs ${due.urgent ? "font-medium text-warn" : "text-muted"}`}>
      {shortDate(iso)} · {due.text}
    </span>
  );
}

export function AssignmentRow({ a, course, onClick }: { a: ItemSummary; course: number; onClick: () => void }) {
  return (
    <Row onClick={onClick} pin={{ course, kind: "assignment", id: a.id, title: a.title }}>
      <div className="flex items-center gap-2">
        {a.new && <NewDot label={t("新作业")} />}
        <span className={`truncate ${a.new ? "font-medium" : ""}`}>{a.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5"><SubmissionBadges a={a} quiet /><Due iso={a.due_at} /></span>
      </div>
    </Row>
  );
}

/** Words typed in the search box, all of which a title must contain. */
function matcher(query: string): ((title: string) => boolean) | null {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? (title) => words.every((w) => title.toLowerCase().includes(w)) : null;
}

/** Above a list narrowed by the search box. */
function FilterNote({ n, onWiden }: { n: number; onWiden: () => void }) {
  return (
    <p className="flex items-center gap-2 px-2.5 pt-1 pb-2 text-xs text-muted">
      {n ? t("找到 {n} 个", { n }) : t("没有找到")}
      <button onClick={onWiden} className="text-accent hover:underline">{t("搜索整门课 ›")}</button>
    </p>
  );
}

// -- 模块 ----------------------------------------------------------------------------------

const ITEM_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  Page: BookOpen, Assignment: ClipboardList, Quiz: ListChecks, Discussion: MessagesSquare,
  ExternalUrl: Link, ExternalTool: AppWindow,
};

/** The course as the instructor laid it out. Opens with the current modules expanded
 * (newest upload, next deadline); what you expand or collapse is remembered per course. */
export function CourseModules({ course, version, focus, only, onOpenDoc, onShowFolder, query, onWiden }: {
  course: Course;
  version: number;
  focus?: number; // a module to show: opened, and scrolled to (as from 置顶)
  only?: number; // just this module, open (a tab of its own)
  onOpenDoc: (kind: DocKind, id: string) => void;
  onShowFolder: (path: string) => void;
  query: string; // the search box: only items (or modules) with these words in their titles
  onWiden: () => void;
}) {
  const [list, setList] = useState<Module[] | null>(null);
  const [open, setOpen] = usePref<number[] | null>(`modules-open:${course.id}`, null);
  const { launch, pending } = useLaunch(course.id);
  const pinnable = usePinnable();
  useEffect(() => {
    api.modules(course.id).then(setList, () => setList([]));
  }, [course.id, version]);

  const expanded = new Set(open ?? (list ?? []).filter((m) => m.current).map((m) => m.id));
  const loaded = list !== null;
  useEffect(() => {
    if (focus === undefined || !loaded) return;
    if (!expanded.has(focus)) setOpen([...expanded, focus]);
    document.getElementById(`module-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: number) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    setOpen([...next]);
  };

  const activate = (it: ModuleItem) => {
    if (it.file) void api.openPath(it.file);
    else if (it.doc) onOpenDoc(it.doc.kind, it.doc.id);
    else if (it.external) void api.openExternal(it.external);
    else if (it.tool) launch(`item:${it.tool.module_item_id}`, { module_item_id: it.tool.module_item_id });
    else if (it.url) void api.openUrl(it.url);
  };

  if (list === null) return <p className="px-6 py-8 text-sm text-muted">{t("正在加载…")}</p>;
  if (list.length === 0) {
    return <p className="px-6 py-8 text-sm text-muted">{t("还没有模块。（新加的课程同步一次后就会显示。）")}</p>;
  }
  // Searching: modules whose name matches, whole; elsewhere just the matching items; all open.
  const match = matcher(query);
  if (only !== undefined && !list.some((m) => m.id === only)) return <p className="px-6 py-8 text-sm text-muted">{t("找不到这个模块了")}</p>;
  const shown = only !== undefined
    ? list.filter((m) => m.id === only)
    : match
    ? list.flatMap((m) => {
        if (match(m.name)) return [m];
        const items = m.items.filter((i) => i.type !== "SubHeader" && match(i.title));
        return items.length ? [{ ...m, items }] : [];
      })
    : list;
  const found = shown.reduce((n, m) => n + m.items.filter((i) => i.type !== "SubHeader").length, 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-4">
        {only !== undefined ? null : match ? (
          <FilterNote n={found} onWiden={onWiden} />
        ) : (
          <div className="mb-2 flex justify-end gap-3 text-xs text-muted">
            <button className="hover:text-fg" onClick={() => setOpen(list.map((m) => m.id))}>{t("全部展开")}</button>
            <button className="hover:text-fg" onClick={() => setOpen([])}>{t("全部收起")}</button>
          </div>
        )}
        {shown.map((m) => {
          const isOpen = only !== undefined || !!match || expanded.has(m.id);
          const locked = m.state === "locked";
          return (
            <section key={m.id} id={`module-${m.id}`} className={`mb-2 scroll-mt-4 rounded-xl border bg-panel ${m.id === focus ? "border-accent/70" : "border-line"}`}>
              <header className="group flex items-center gap-2 px-3 py-2" {...pinnable({ course: course.id, module: m.id, title: m.name })}>
                <button onClick={() => toggle(m.id)} aria-expanded={isOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />}
                  <span className="truncate font-medium">{m.name}</span>
                  {m.current && <span className="shrink-0 rounded bg-info-soft px-1.5 text-[11px] text-info">{t("当前")}</span>}
                  {locked && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                      <Lock className="size-3" />{m.unlock_at ? t("{date} 解锁", { date: shortDate(m.unlock_at) }) : t("未解锁")}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted">{t("{n} 项", { n: m.items.filter((i) => i.type !== "SubHeader").length })}</span>
                </button>
                {m.folder && (
                  <button
                    title={t("在“文件”中查看这个模块的文件夹")}
                    onClick={() => onShowFolder(m.folder!)}
                    className="shrink-0 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-chip hover:text-fg focus:opacity-100"
                  >
                    <FolderOpen className="size-4" />
                  </button>
                )}
              </header>
              {isOpen && (
                <ul className="border-t border-line px-2 py-1">
                  {m.items.length === 0 && <li className="px-2 py-2 text-sm text-muted">{t("空的")}</li>}
                  {m.items.map((it, i) => (
                    <ModuleRow key={it.id ?? i} it={it} course={course.id} opening={!!it.tool && pending === `item:${it.tool.module_item_id}`} onClick={() => activate(it)} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** What a module item is, to pin: its file, its page (or assignment...), or the web page it links to. */
const itemTarget = (it: ModuleItem, course: number): PinTarget | null =>
  it.file ? { file: it.file }
    : it.doc ? { course, kind: it.doc.kind, id: it.doc.id, title: it.title }
      : it.external ? { url: it.external, title: it.title }
        : null;

export function ModuleRow({ it, course, opening, onClick }: { it: ModuleItem; course: number; opening: boolean; onClick: () => void }) {
  const pinnable = usePinnable();
  const pad = { paddingLeft: 8 + it.indent * 20 };
  if (it.type === "SubHeader") {
    return <li style={pad} className="pt-2.5 pb-1 text-xs font-medium text-muted">{it.title}</li>;
  }
  const Icon = ITEM_ICON[it.type];
  const leavesApp = !it.file && !it.doc;
  return (
    <li>
      <button
        onClick={onClick}
        {...pinnable(it.deleted ? null : itemTarget(it, course))}
        style={pad}
        title={
          it.deleted ? t("你删除了这个文件；在 Canvas 中打开")
            : it.tool ? (it.tool.name ? t("在浏览器中打开 {name}（通过 Canvas 登录）", { name: it.tool.name }) : t("在浏览器中打开这个工具（通过 Canvas 登录）"))
              : leavesApp ? t("在浏览器中打开") : undefined
        }
        className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm hover:bg-chip ${it.deleted ? "opacity-55" : ""}`}
      >
        {it.type === "File" ? <FileIcon name={it.title} /> : Icon ? <Icon className="size-4 shrink-0 text-muted" /> : <FileText className="size-4 shrink-0 text-muted" />}
        <span className={`truncate ${it.deleted ? "line-through" : ""} ${it.new ? "font-medium" : ""}`}>{it.title}</span>
        {it.new && <NewDot />}
        {it.done && <Check className="size-3.5 shrink-0 text-type-sheet" aria-label={t("已完成")} />}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {opening && <span className="text-xs text-muted">{t("正在打开…")}</span>}
          {it.due_at && <Due iso={it.due_at} />}
          {leavesApp && <ExternalLink className="size-3.5 text-muted" aria-label={t("在浏览器中打开")} />}
        </span>
      </button>
    </li>
  );
}

// -- 公告 / 作业 / 页面 / 大纲 --------------------------------------------------------------

/** One announcement, assignment or page (or the syllabus) as a tab of its own. */
export function CourseDoc({ course, kind, id, version, onNavigate, onSeen }: {
  course: Course;
  kind: DocKind;
  id: string;
  version: number;
  onNavigate: (to: CourseLink) => void;
  onSeen: () => void; // it was new, and now it's been opened
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ItemView key={`${kind}:${id}`} course={course} kind={kind} id={id} version={version} onNavigate={onNavigate} onLoaded={(it) => it.new && onSeen()} />
    </div>
  );
}

/** A list on the left, the selected item on the right, like a mail client. */
export function CourseReader({ course, tab, selected, version, onSelect, onNavigate, onSeen, query, onWiden }: {
  course: Course;
  tab: CourseTab;
  selected: string | null;
  version: number;
  onSelect: (id: string) => void;
  onNavigate: (to: CourseLink) => void;
  onSeen: () => void;
  query: string; // the search box: the list shows what matches, best first (titles and text)
  onWiden: () => void;
}) {
  const kind = KIND_OF_TAB[tab]!;
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  // Opened here: no dot, even if the list was fetched before opening it marked it seen.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  useEffect(() => {
    setItems(null);
    api.items(course.id, kind).then(setItems, () => setItems([]));
  }, [course.id, kind, version]);
  const all = useMemo(() => items && items.map((x) => (x.new && opened.has(x.id) ? { ...x, new: false } : x)), [items, opened]);
  const searching = query.trim() !== "" && kind !== "syllabus";
  const found = useSearch(
    searching ? query : "",
    (q) => (q ? api.search(q, { courses: [course.id], kinds: [kind], limit: 200 }) : Promise.resolve([])),
    [course.id, kind, version],
  );
  const list = useMemo(() => {
    if (!searching || !all) return all;
    const byId = new Map(all.map((x) => [x.id, x]));
    return found.hits.flatMap((h) => (h.doc_id && byId.has(h.doc_id) ? [byId.get(h.doc_id)!] : []));
  }, [all, found.hits, searching]);

  // Nothing chosen yet: the newest announcement, the next assignment, the front page (or the best match).
  const current = selected ?? list?.[0]?.id ?? null;
  const seen = (id: string) => {
    setOpened((s) => new Set(s).add(id));
    onSeen(); // the counts in the tabs and the sidebar
  };

  if (kind === "syllabus") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ItemView course={course} kind="syllabus" id={String(course.id)} version={version} onNavigate={onNavigate} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <ul className="w-80 shrink-0 overflow-y-auto border-r border-line p-2" aria-label={t("列表")}>
        {searching && !found.loading && <li><FilterNote n={list?.length ?? 0} onWiden={onWiden} /></li>}
        {list === null && <li className="px-2 py-3 text-sm text-muted">{t("正在加载…")}</li>}
        {list?.length === 0 && !searching && <li className="px-2 py-3 text-sm text-muted">{t("什么都没有")}</li>}
        {kind === "assignment" ? <AssignmentList course={course.id} list={list ?? []} current={current} onSelect={onSelect} /> : (list ?? []).map((it) => (
          <ListRow key={it.id} it={it} pin={{ course: course.id, kind, id: it.id, title: it.title }} active={it.id === current} onClick={() => onSelect(it.id)} />
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {current && (
          <ItemView
            key={`${kind}:${current}`}
            course={course}
            kind={kind}
            id={current}
            version={version}
            onNavigate={onNavigate}
            onLoaded={(it) => it.new && seen(it.id)}
          />
        )}
      </div>
    </div>
  );
}

function ListRow({ it, pin, active, onClick }: { it: ItemSummary; pin: PinTarget; active: boolean; onClick: () => void }) {
  const pinnable = usePinnable();
  return (
    <li>
      <button onClick={onClick} {...pinnable(pin)} className={`block w-full rounded-md px-2.5 py-2 text-left ${active ? "bg-selected" : "hover:bg-chip"}`}>
        <div className="flex items-center gap-2">
          {it.new && <NewDot />}
          <span className={`truncate text-sm ${it.new ? "font-medium" : ""}`}>{it.title}</span>
          {it.front_page && <span className="shrink-0 rounded bg-chip px-1 text-[10px] text-muted">{t("首页")}</span>}
          <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(it.date, false)}</span>
        </div>
        {it.preview && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{it.preview}</p>}
        {it.author && !it.preview && <p className="mt-0.5 text-xs text-muted">{it.author}</p>}
      </button>
    </li>
  );
}

function AssignmentList({ course, list, current, onSelect }: { course: number; list: ItemSummary[]; current: string | null; onSelect: (id: string) => void }) {
  const pinnable = usePinnable();
  const groups = useMemo(() => {
    const now = Date.now();
    const g: [string, ItemSummary[]][] = [[t("即将截止"), []], [t("已过截止"), []], [t("没有截止日期"), []]];
    for (const a of list) {
      const t = a.due_at ? new Date(a.due_at).getTime() : null;
      g[t === null ? 2 : t >= now ? 0 : 1][1].push(a);
    }
    return g.filter(([, xs]) => xs.length);
  }, [list]);
  return (
    <>
      {groups.map(([name, xs]) => (
        <li key={name}>
          <h3 className="px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted">{name}</h3>
          <ul>
            {xs.map((a) => (
              <li key={a.id}>
                <button onClick={() => onSelect(a.id)} {...pinnable({ course, kind: "assignment", id: a.id, title: a.title })}
                  className={`block w-full rounded-md px-2.5 py-2 text-left ${a.id === current ? "bg-selected" : "hover:bg-chip"}`}>
                  <div className="flex items-center gap-2">
                    {a.new && <NewDot />}
                    <span className={`truncate text-sm ${a.new ? "font-medium" : ""}`}>{a.title}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Due iso={a.due_at} />
                    {a.points != null && a.status !== "graded" && <span className="text-xs text-muted">· {t("{n} 分", { n: fmt(a.points) })}</span>}
                    <SubmissionBadges a={a} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </>
  );
}

const SUBMISSION: Record<string, string> = {
  online_upload: t("上传文件"), online_text_entry: t("在线文本"), online_url: t("网址"), online_quiz: t("测验"),
  discussion_topic: t("讨论"), external_tool: t("外部工具"), on_paper: t("纸质"), none: t("不需要提交"), media_recording: t("录音/录像"),
};

function ItemView({ course, kind, id, version, onNavigate, onLoaded }: {
  course: Course;
  kind: DocKind;
  id: string;
  version: number;
  onNavigate: (to: CourseLink) => void;
  onLoaded?: (it: Item) => void; // (loading it marked it seen)
}) {
  const [it, setIt] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { launch, pending } = useLaunch(course.id);
  useEffect(() => {
    setIt(null);
    setError(null);
    api.item(course.id, kind, id).then((x) => {
      setIt(x);
      onLoaded?.(x);
    }, (e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course.id, kind, id, version]);

  if (error) {
    return (
      <div className="p-8 text-sm text-fg-soft">
        <p>{t("在已同步的内容里找不到它（可能是新的，或者不是公告）。")}</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-2 text-accent hover:underline">{t("在 Canvas 中打开这门课")}</button>
      </div>
    );
  }
  if (!it) return <p className="p-8 text-sm text-muted">{t("正在加载…")}</p>;
  const submit = kind === "assignment" && it.submission_types?.some((t) => t.startsWith("online") || t === "external_tool");
  return (
    <article className="mx-auto max-w-3xl px-8 py-6">
      <header className="mb-4 border-b border-line pb-4">
        <h1 className="selectable text-xl font-semibold">{kind === "syllabus" ? t("课程大纲") : it.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {kind === "announcement" && <>{it.author && <span>{it.author}</span>}<span>{shortDate(it.date)}</span></>}
          {kind === "assignment" && (
            <>
              <Due iso={it.due_at} />
              {it.points != null && <span>{t("{n} 分", { n: fmt(it.points) })}</span>}
              {!!it.submission_types?.length && <span>{it.submission_types.map((s) => SUBMISSION[s] ?? s).join(t("、"))}</span>}
              <span className="flex items-center gap-1"><SubmissionBadges a={it} /></span>
              {it.submitted_at && <span>{t("提交于 {date}", { date: shortDate(it.submitted_at) })}</span>}
            </>
          )}
          {kind === "page" && it.date && <span>{t("更新于 {date}", { date: shortDate(it.date) })}</span>}
          {it.tool ? (
            <span className="ml-auto flex items-center gap-3">
              {it.url && (
                <button onClick={() => void api.openUrl(it.url!)} className="text-muted hover:text-fg hover:underline">{t("在 Canvas 中打开")}</button>
              )}
              <button
                onClick={() => launch("assignment", { assignment_id: it.tool!.assignment_id })}
                title={t("在浏览器中打开（通过 Canvas 登录）")}
                className="flex items-center gap-1 text-accent hover:underline"
              >
                {pending === "assignment" ? t("正在打开…") : it.tool.name ? t("在 {name} 中打开", { name: it.tool.name }) : t("在外部工具中打开")}
                <ExternalLink className="size-3.5" />
              </button>
            </span>
          ) : it.url && (
            <button onClick={() => void api.openUrl(it.url!)} className="ml-auto flex items-center gap-1 text-accent hover:underline">
              {submit ? t("在 Canvas 中提交") : t("在 Canvas 中打开")}
              <ExternalLink className="size-3.5" />
            </button>
          )}
        </div>
      </header>
      {it.attachments.length > 0 && (
        <ul className="mb-4 flex flex-wrap gap-2">
          {it.attachments.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => void (a.path ? api.openPath(a.path) : api.openUrl(`/courses/${course.id}/files/${a.id}`))}
                className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:bg-chip"
              >
                <Paperclip className="size-3.5 text-muted" />
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {it.html.trim() ? (
        <RichText html={it.html} courseId={course.id} files={it.files} onNavigate={onNavigate} />
      ) : (
        <p className="text-sm text-muted">{t("没有正文。")}</p>
      )}
    </article>
  );
}

// -- 成绩 ----------------------------------------------------------------------------------

/** Your total as Canvas computes it, and every assignment's grade, latest due first. */
export function CourseGrades({ course, version, onOpenDoc, query, onWiden }: {
  course: Course;
  version: number;
  onOpenDoc: (kind: DocKind, id: string) => void;
  query: string; // the search box: only assignments with these words in their titles
  onWiden: () => void;
}) {
  const pinnable = usePinnable();
  const [g, setG] = useState<Grades | null>(null);
  useEffect(() => {
    api.grades(course.id).then(setG, () => setG({ total: null, assignments: [] }));
  }, [course.id, version]);
  if (!g) return <p className="px-6 py-8 text-sm text-muted">{t("正在加载…")}</p>;
  const { total } = g;
  const match = matcher(query);
  const rows = match ? g.assignments.filter((a) => match(a.title)) : g.assignments;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <section className="mb-5 rounded-xl border border-line bg-panel px-5 py-4">
          {total ? (
            <>
              <p className="mb-1 text-xs text-muted">{t("当前总评")}</p>
              <TotalLine total={total} big />
              <p className="mt-1.5 text-xs text-muted">
                {t("只算已经评分的作业，按 Canvas 的计算方式；每次同步时更新。")}
                {total.final_score != null && total.final_score !== total.current_score && (
                  <> {t("未评分的都按 0 分算的话是 {score}%。", { score: fmt(total.final_score) })}</>
                )}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">{t("这门课在 Canvas 上不显示总评。")}</p>
          )}
        </section>
        {match && <FilterNote n={rows.length} onWiden={onWiden} />}
        {rows.length === 0 && !match ? (
          <p className="text-sm text-muted">{t("还没有作业。")}</p>
        ) : (
          <ul className="rounded-xl border border-line bg-panel p-1.5">
            <li className="grid grid-cols-[minmax(0,1fr)_9rem_minmax(7rem,auto)] gap-3 px-2.5 py-1.5 text-[11px] font-medium text-muted">
              <span>{t("作业")}</span><span>{t("截止")}</span><span className="text-right">{t("成绩")}</span>
            </li>
            {rows.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => onOpenDoc("assignment", a.id)}
                  {...pinnable({ course: course.id, kind: "assignment", id: a.id, title: a.title })}
                  className="grid w-full grid-cols-[minmax(0,1fr)_9rem_minmax(7rem,auto)] items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-chip"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {a.new && <NewDot />}
                    <span className="truncate">{a.title}</span>
                  </span>
                  <span className="truncate text-xs text-muted">{a.due_at ? shortDate(a.due_at) : "—"}</span>
                  <span className="flex justify-end gap-1">
                    <SubmissionBadges a={a} />
                    {!scoreText(a) && a.points != null && <span className="text-xs text-muted tabular-nums">— / {fmt(a.points)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
