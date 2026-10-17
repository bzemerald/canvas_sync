// A course's page: its tabs (概览 first), and its views: the overview, readers for
// announcements, assignments, pages and the syllabus, modules, grades. The 文件 tab is the file
// browser, rendered by the main window. A blue dot marks what's new to you; opening it clears it.
import {
  Check, ChevronDown, ChevronRight, ExternalLink, FileText, FolderOpen, Link, ListChecks, Lock, MessagesSquare, Paperclip,
  AppWindow, BookOpen, ClipboardList,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type { Course, DocKind, Grades, Item, ItemSummary, LaunchTarget, ModuleItem, NewCounts, Overview, Total } from "../lib/api";
import { useDropZone } from "../lib/dropZones";
import { usePref } from "../lib/prefs";
import { useLoaded } from "../lib/useLoaded";
import { useSearch } from "../lib/useSearch";
import { shortDate, untilDue } from "../lib/dates";
import { moved, useReorder } from "../lib/reorder";
import {
  type Shown, type Thing, type ViewName, changed, ofCourse, opensElsewhere, ownIn, putAt, refill, same, slotIndex, thingKey,
  thingOfItem, without,
} from "../lib/things";
import { FileIcon } from "./FileIcon";
import type { MenuItem } from "./Menu";
import { RenameDialog } from "./RenameDialog";
import { Count, Loading, NewDot } from "./Status";
import { RichText } from "./RichText";
import { ThingIcon, opensHint, ownName, pinItem, sections, thingName, useThing, useThings } from "./Things";
import { t } from "../lib/i18n";

/** Where each kind of document is listed. */
export const KIND_VIEW: Record<DocKind, ViewName> = {
  announcement: "announcements", assignment: "assignments", page: "pages", syllabus: "syllabus",
};
export const VIEW_KIND: Partial<Record<ViewName, DocKind>> = {
  announcements: "announcement", assignments: "assignment", pages: "page", syllabus: "syllabus",
};

/** The overview, loaded once per course and version (it also says which tabs to show).
 * `seen` changes when you open something, so the counts of what's new follow. */
export function useOverview(courseId: number | null, version: number, seen: number) {
  return useLoaded(courseId === null ? null : `overview:${courseId}`, () => api.overview(courseId!), [version, seen]).value ?? null;
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

/** Opening a module's item: where it leads (a file, a page, a link), or the tool it is. */
export function useItemOpener(course: number) {
  const things = useThings();
  const { launch, pending } = useLaunch(course);
  const activate = (it: ModuleItem) => {
    const x = thingOfItem(it, course);
    if (it.tool) launch(`item:${it.tool.module_item_id}`, { module_item_id: it.tool.module_item_id });
    else if (x) things.open(x);
    else if (it.url) void api.openUrl(it.url);
  };
  return { activate, pending };
}

export const totalNew = (n: NewCounts | undefined) => (n ? n.announcements + n.assignments + n.pages + n.files : 0);

/** The views of a course with something in them (the rest aren't shown as tabs). */
export function viewsWithContent(overview: Overview | null): Set<ViewName> {
  const c = overview?.counts;
  const has: Record<ViewName, boolean> = {
    overview: true, modules: !!c?.modules, announcements: !!c?.announcements, assignments: !!c?.assignments,
    grades: !!c?.grades, files: true, syllabus: !!c?.syllabus, pages: !!c?.pages, tools: true, canvas: true,
  };
  return new Set((Object.keys(has) as ViewName[]).filter((v) => has[v]));
}

/** A course's tabs: its views, and whatever of the course you put there (a page, a folder, a
 * module, a tool, a note, a search; or a web link). Drag them into your order; drag something of
 * the course onto them and it's a tab where you let go; drag one you put there off, and it's
 * gone. Right-click to rename any of them, hide the course's own, take away what you put there.
 * Views with nothing in them aren't shown; 概览 and 文件 always are, unless you hid them.
 * Something shown that isn't a tab (a page, when 页面 is hidden) gets one for now, at the end. */
export function CourseTabs({
  course, tab, overview, entries: loaded, own, onTab, onArrange, onReset, onMakeDefault, onSay, onMarkAllSeen,
}: {
  course: Course;
  tab: Thing; // what's showing
  overview: Overview | null;
  entries: Shown[] | null; // every tab, in order, hidden ones too (null: not loaded yet)
  own: boolean; // arranged for this course (else as every course is)
  onTab: (t: Thing) => void;
  onArrange: (entries: Shown[]) => void; // for this course
  onReset: () => void; // back to how every course is
  onMakeDefault: () => void; // every course (not arranged for itself) like this one
  onSay: (message: string, action?: { label: string; run: () => void }) => void;
  onMarkAllSeen: () => void;
}) {
  const things = useThings();
  const bar = useRef<HTMLElement>(null);
  const [renaming, setRenaming] = useState<Shown | null>(null);
  const entries = loaded ?? [];
  const n = overview?.new;
  const has = viewsWithContent(overview);
  const fresh: Partial<Record<ViewName, number>> = {
    announcements: n?.announcements, assignments: n?.assignments, files: n?.files, pages: n?.pages,
  };
  const isOwn = (e: Thing): e is Thing & { type: "view" } => ownIn("tabs", e, course.id);
  const visible = entries.filter((e) => same(e, tab) || (!e.hidden && (!isOwn(e) || has.has(e.view))));
  const extra = !loaded || entries.some((e) => same(e, tab)) ? null : (tab as Shown); // shown, but not one of the tabs
  const name = (e: Shown) => thingName(e, things.courses, "tab");

  const takeAway = (e: Shown) => {
    onArrange(without(entries, e));
    onSay(t("已移除标签“{name}”", { name: name(e) }), { label: t("撤销"), run: () => onArrange(entries) });
  };
  // Dropped on the tabs: a tab, where it was let go (one already: it moves there, shown).
  const put = (entry: Shown, slot: number) => onArrange(putAt(entries, { ...entry, hidden: false }, slotIndex(entries, visible, slot)));
  const slotAt = (x: number) => {
    const tabs = Array.from(bar.current?.querySelectorAll<HTMLElement>(":scope > [data-tab]") ?? []);
    const i = tabs.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    return i < 0 ? visible.length : Math.min(i, visible.length);
  };
  const zone = useDropZone(put, (x) => slotAt(x), (e) => ofCourse(e, course));
  const drag = useReorder(visible.length, (from, to) => onArrange(refill(entries, visible, moved(visible, from, to))), "x", {
    zone: zone.id,
    thing: (i) => visible[i],
    remove: (i) => (isOwn(visible[i]) ? null : () => takeAway(visible[i])),
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

  /** A tab, right-clicked: what's to do with it, and with it as a tab. */
  const menu = (e: Shown): MenuItem[] => sections(
    isOwn(e) ? [] : things.ways(e),
    e === extra
      ? [{ label: t("加为标签"), onSelect: () => onArrange([...entries, { ...e, hidden: false }]) }]
      : [
          { label: t("重命名…"), onSelect: () => setRenaming(e) },
          ...(e.title ? [{ label: t("恢复原名（{name}）", { name: ownName(e, things.courses, "tab") }), onSelect: () => onArrange(changed(entries, e, { title: "" })) }] : []),
          isOwn(e)
            ? { label: t("隐藏“{name}”标签", { name: name(e) }), disabled: visible.length <= 1, onSelect: () => onArrange(changed(entries, e, { hidden: true })) }
            : { label: t("移除这个标签"), onSelect: () => takeAway(e) },
        ],
    [pinItem(things, e)],
  );
  /** The bar, right-clicked where there's no tab: the tabs as a whole. */
  const barMenu = (): MenuItem[] => sections(
    entries.filter((x) => x.hidden).map((x) => ({
      label: t("显示“{name}”标签", { name: name(x) }), onSelect: () => onArrange(changed(entries, x, { hidden: false })),
    })),
    [
      { label: t("设为所有课程的默认排列"), onSelect: onMakeDefault },
      { label: t("恢复默认（和其他课程一样）"), disabled: !own, onSelect: onReset },
    ],
  );

  const button = (e: Shown, props: object, i: number | null) => (
    <button
      key={thingKey(e)}
      data-tab={i === null ? undefined : ""}
      {...props}
      onClick={() => (opensElsewhere(e) ? things.open(e) : onTab(e))}
      onContextMenu={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        things.menu(menu(e), ev.clientX, ev.clientY);
      }}
      aria-current={same(tab, e) ? "page" : undefined}
      title={opensHint(e) ?? (!isOwn(e) && i !== null ? t("拖离标签栏可以移除") : undefined)}
      className={`relative -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${same(tab, e) ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"} ${e.hidden || e === extra ? "italic" : ""}`}
    >
      {!isOwn(e) && <ThingIcon thing={e} courses={things.courses} className="size-3.5" />}
      <span className="max-w-48 truncate">{name(e)}</span>
      {isOwn(e) && !!fresh[e.view] && <Count n={fresh[e.view]!} label={t("{n} 个新的", { n: fresh[e.view]! })} />}
      {things.opening === thingKey(e) && <span className="text-xs text-muted">{t("正在打开…")}</span>}
    </button>
  );

  return (
    <nav
      ref={(el) => {
        bar.current = el;
        zone.ref(el); // (what drops land on)
      }}
      className={`no-scrollbar relative flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-4 ${
        zone.state === "over" ? "bg-accent/10" : zone.state === "ready" ? "outline-1 -outline-offset-2 outline-dashed outline-accent/60" : ""
      }`}
      aria-label={t("课程")}
      onContextMenu={(e) => {
        e.preventDefault(); // (a tab has its own menu)
        things.menu(barMenu(), e.clientX, e.clientY);
      }}
    >
      {visible.map((e, i) => button(e, drag.item(i), i))}
      {extra && button(extra, {}, null)}
      {!loaded && <span aria-hidden className="invisible py-2 text-sm">&nbsp;</span>}
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
          current={name(renaming)}
          title={t("重命名标签")}
          hint={t("只改这个标签的名字。")}
          onClose={() => setRenaming(null)}
          onSubmit={(title) => {
            onArrange(changed(entries, renaming, { title }));
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

/** A row in a card or list; `thing`: what it is, to drag somewhere or right-click. */
export function Row({ onClick, thing, children }: { onClick: () => void; thing?: Shown | null; children: React.ReactNode }) {
  const props = useThing();
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === "Enter" && onClick()} {...props(thing)}
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

/** An announcement, assignment or page, as a thing (named as it's listed). */
export const docThing = (course: number, it: ItemSummary): Shown =>
  it.kind === "syllabus" ? { type: "view", course, view: "syllabus" } : { type: "doc", course, kind: it.kind, id: it.id, name: it.title };

export function AssignmentRow({ a, course, onClick }: { a: ItemSummary; course: number; onClick: () => void }) {
  return (
    <Row onClick={onClick} thing={docThing(course, a)}>
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
export function CourseModules({ course, version, focus, only, query, onWiden }: {
  course: Course;
  version: number;
  focus?: number; // a module to show: opened, and scrolled to (as from 置顶)
  only?: number; // just this module, open (a tab of its own)
  query: string; // the search box: only items (or modules) with these words in their titles
  onWiden: () => void;
}) {
  const list = useLoaded(`modules:${course.id}`, () => api.modules(course.id).catch(() => []), [version]).value ?? null;
  const [open, setOpen] = usePref<number[] | null>(`modules-open:${course.id}`, null);
  const { activate, pending } = useItemOpener(course.id);
  const things = useThings();
  const thing = useThing();

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

  if (list === null) return <Loading />;
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
              <header className="group flex items-center gap-2 px-3 py-2" {...thing({ type: "module", course: course.id, module: m.id, name: m.name })}>
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
                    onClick={() => things.open({ type: "folder", path: m.folder! })}
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

export function ModuleRow({ it, course, opening, onClick }: { it: ModuleItem; course: number; opening: boolean; onClick: () => void }) {
  const thing = useThing();
  const what = thingOfItem(it, course);
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
        {...thing(what && { ...what, name: it.title })}
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
export function CourseDoc({ course, kind, id, version, onSeen }: {
  course: Course;
  kind: DocKind;
  id: string;
  version: number;
  onSeen: () => void; // it was new, and now it's been opened
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ItemView key={`${kind}:${id}`} course={course} kind={kind} id={id} version={version} onLoaded={(it) => it.new && onSeen()} />
    </div>
  );
}

/** A list on the left, the selected item on the right, like a mail client. */
export function CourseReader({ course, kind, selected, version, onSelect, onSeen, query, onWiden }: {
  course: Course;
  kind: DocKind;
  selected: string | null;
  version: number;
  onSelect: (id: string) => void;
  onSeen: () => void;
  query: string; // the search box: the list shows what matches, best first (titles and text)
  onWiden: () => void;
}) {
  const items = useLoaded(`items:${course.id}:${kind}`, () => api.items(course.id, kind).catch(() => []), [version]).value ?? null;
  // Opened here: no dot, even if the list was fetched before opening it marked it seen.
  const [opened, setOpened] = useState<Set<string>>(new Set());
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
        <ItemView course={course} kind="syllabus" id={String(course.id)} version={version} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <ul className="w-80 shrink-0 overflow-y-auto border-r border-line p-2" aria-label={t("列表")}>
        {searching && !found.loading && <li><FilterNote n={list?.length ?? 0} onWiden={onWiden} /></li>}
        {list === null && <li><Loading className="px-2 py-3 text-sm" /></li>}
        {list?.length === 0 && !searching && <li className="px-2 py-3 text-sm text-muted">{t("什么都没有")}</li>}
        {kind === "assignment" ? <AssignmentList course={course.id} list={list ?? []} current={current} onSelect={onSelect} /> : (list ?? []).map((it) => (
          <ListRow key={it.id} it={it} thing={docThing(course.id, it)} active={it.id === current} onClick={() => onSelect(it.id)} />
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
            onLoaded={(it) => it.new && seen(it.id)}
          />
        )}
      </div>
    </div>
  );
}

function ListRow({ it, thing, active, onClick }: { it: ItemSummary; thing: Shown; active: boolean; onClick: () => void }) {
  const props = useThing();
  return (
    <li>
      <button onClick={onClick} {...props(thing)} className={`block w-full rounded-md px-2.5 py-2 text-left ${active ? "bg-selected" : "hover:bg-chip"}`}>
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
  const thing = useThing();
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
                <button onClick={() => onSelect(a.id)} {...thing(docThing(course, a))}
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

function ItemView({ course, kind, id, version, onLoaded }: {
  course: Course;
  kind: DocKind;
  id: string;
  version: number;
  onLoaded?: (it: Item) => void; // (loading it marked it seen)
}) {
  const { value: it, error } = useLoaded(`item:${course.id}:${kind}:${id}`, () => api.item(course.id, kind, id).then((x) => {
    onLoaded?.(x);
    return x;
  }), [version]);
  const { launch, pending } = useLaunch(course.id);

  if (error) {
    return (
      <div className="p-8 text-sm text-fg-soft">
        <p>{t("在已同步的内容里找不到它（可能是新的，或者不是公告）。")}</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-2 text-accent hover:underline">{t("在 Canvas 中打开这门课")}</button>
      </div>
    );
  }
  if (!it) return <Loading className="p-8 text-sm" />;
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
        <RichText html={it.html} files={it.files} />
      ) : (
        <p className="text-sm text-muted">{t("没有正文。")}</p>
      )}
    </article>
  );
}

// -- 成绩 ----------------------------------------------------------------------------------

/** Your total as Canvas computes it, and every assignment's grade, latest due first. */
export function CourseGrades({ course, version, query, onWiden }: {
  course: Course;
  version: number;
  query: string; // the search box: only assignments with these words in their titles
  onWiden: () => void;
}) {
  const thing = useThing();
  const things = useThings();
  const g = useLoaded(`grades:${course.id}`, () => api.grades(course.id).catch((): Grades => ({ total: null, assignments: [] })), [version]).value;
  if (!g) return <Loading />;
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
                  onClick={() => things.open(docThing(course.id, a))}
                  {...thing(docThing(course.id, a))}
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
