// A course's page: tabs (概览 first), the overview, and readers for announcements,
// assignments, pages, the syllabus and grades. The 文件 tab is the file browser, rendered
// by the main window. A blue dot marks what's new to you; opening it clears the dot.
import {
  AppWindow, Award, BookOpen, Check, ChevronDown, ChevronRight, ClipboardList, ExternalLink, FileText, FolderOpen, Link, ListChecks, Lock,
  Megaphone, MessagesSquare, Paperclip, ScrollText,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import type { Course, DocKind, Grades, Item, ItemSummary, Module, ModuleItem, NewCounts, Overview, Total } from "../lib/api";
import { usePref } from "../lib/prefs";
import { shortDate, untilDue } from "../lib/dates";
import { fileManager } from "../lib/keys";
import { FileIcon } from "./FileIcon";
import { Count, NewDot } from "./Status";
import { RichText, type CourseLink } from "./RichText";

export type CourseTab = "overview" | "modules" | "announcements" | "assignments" | "grades" | "files" | "syllabus" | "pages";

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

export const totalNew = (n: NewCounts | undefined) => (n ? n.announcements + n.assignments + n.pages + n.files : 0);

export function CourseTabs({ tab, overview, onTab, onMarkAllSeen }: {
  tab: CourseTab;
  overview: Overview | null;
  onTab: (t: CourseTab) => void;
  onMarkAllSeen: () => void;
}) {
  const c = overview?.counts;
  const n = overview?.new;
  // Tabs with nothing in them aren't shown; 概览 and 文件 always are.
  const tabs: [CourseTab, string, boolean, number][] = [
    ["overview", "概览", true, 0],
    ["modules", "模块", !!c?.modules, 0],
    ["announcements", "公告", !!c?.announcements, n?.announcements ?? 0],
    ["assignments", "作业", !!c?.assignments, n?.assignments ?? 0],
    ["grades", "成绩", !!c?.grades, 0],
    ["files", "文件", true, n?.files ?? 0],
    ["syllabus", "大纲", !!c?.syllabus, 0],
    ["pages", "页面", !!c?.pages, n?.pages ?? 0],
  ];
  return (
    <nav className="flex items-center gap-1 border-b border-line px-4" aria-label="课程">
      {tabs.filter(([t, , shown]) => shown || t === tab).map(([t, label, , fresh]) => (
        <button
          key={t}
          onClick={() => onTab(t)}
          aria-current={tab === t ? "page" : undefined}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === t ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
        >
          {label}
          {fresh > 0 && <Count n={fresh} label={`${fresh} 个新的`} />}
        </button>
      ))}
      {totalNew(n) > 0 && (
        <button onClick={onMarkAllSeen} className="ml-auto shrink-0 py-2 text-xs text-muted hover:text-fg" title="清除这门课所有的“新”标记">
          全部标为已读
        </button>
      )}
    </nav>
  );
}

// -- submissions and grades ----------------------------------------------------------------

const fmt = (x: number) => String(Math.round(x * 100) / 100);

/** A grade the way the assignment is graded: "8.5 / 10", "A-", "通过". */
export function scoreText(a: ItemSummary): string | null {
  if (a.status !== "graded") return null;
  switch (a.grading_type) {
    case "pass_fail":
      return a.grade === "complete" ? "通过" : a.grade === "incomplete" ? "未通过" : a.grade ?? null;
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
  submitted: { text: "已提交", className: "bg-ok-soft text-ok", hint: "已提交，还没有成绩（或成绩还没公布）" },
  missing: { text: "缺交", className: "bg-danger-soft text-danger", hint: "已过截止时间，Canvas 上没有你的提交" },
  excused: { text: "免交", className: "bg-chip text-muted", hint: "老师免除了这项作业" },
  unsubmitted: { text: "未提交", className: "bg-chip text-muted", hint: "Canvas 上还没有你的提交" },
};

/** Handed in? Graded? `quiet`: say nothing about work that's simply not done yet. */
export function SubmissionBadges({ a, quiet = false }: { a: ItemSummary; quiet?: boolean }) {
  const score = scoreText(a);
  const s = a.status && a.status !== "graded" && !(quiet && a.status === "unsubmitted") ? STATUS[a.status] : null;
  return (
    <>
      {score && <span title="成绩" className="rounded bg-ok-soft px-1.5 text-[11px] whitespace-nowrap text-ok tabular-nums">{score}</span>}
      {s && <span title={s.hint} className={`rounded px-1.5 text-[11px] whitespace-nowrap ${s.className}`}>{s.text}</span>}
      {a.late && <span title="提交时已过截止时间" className="rounded bg-warn-soft px-1.5 text-[11px] whitespace-nowrap text-warn">迟交</span>}
    </>
  );
}

function TotalLine({ total, big = false }: { total: Total; big?: boolean }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className={`${big ? "text-3xl" : "text-xl"} font-semibold tabular-nums`}>{fmt(total.current_score)}%</span>
      {total.current_grade && <span className={`${big ? "text-lg" : "text-sm"} font-medium text-fg-soft`}>{total.current_grade}</span>}
    </span>
  );
}

// -- 概览 --------------------------------------------------------------------------------

export function CourseOverview({ course, overview, onOpen, onTab, onSeen }: {
  course: Course;
  overview: Overview | null;
  onOpen: (kind: DocKind, id: string) => void;
  onTab: (t: CourseTab) => void;
  onSeen: () => void;
}) {
  if (!overview) return <p className="px-6 py-8 text-sm text-muted">正在加载…</p>;
  const { upcoming, announcements, new_files, counts, grades } = overview;
  const empty = !counts.announcements && !counts.assignments && !counts.pages && !counts.files && !counts.syllabus;
  if (empty) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-sm text-fg-soft">
        <p className="mb-2 text-base text-fg">这门课在 Canvas 上几乎没有内容。</p>
        <p className="text-muted">很多课程把材料放在课程网站、Ed 或 Gradescope 上。</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-4 text-accent hover:underline">在 Canvas 中打开这门课</button>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-5xl gap-4 p-6 lg:grid-cols-2">
        <Card title="近期截止" icon={<ClipboardList className="size-4" />} more={counts.assignments ? () => onTab("assignments") : undefined}>
          {upcoming.length === 0 ? (
            <Empty>接下来三周没有要交的作业</Empty>
          ) : (
            upcoming.map((a) => <AssignmentRow key={a.id} a={a} onClick={() => onOpen("assignment", a.id)} />)
          )}
        </Card>
        <Card title="最新公告" icon={<Megaphone className="size-4" />} more={counts.announcements ? () => onTab("announcements") : undefined}>
          {announcements.length === 0 ? (
            <Empty>还没有公告</Empty>
          ) : (
            announcements.map((a) => (
              <Row key={a.id} onClick={() => onOpen("announcement", a.id)}>
                <div className="flex items-center gap-2">
                  {a.new && <NewDot label="新公告" />}
                  <span className={`truncate ${a.new ? "font-medium" : ""}`}>{a.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(a.date, false)}</span>
                </div>
                {a.preview && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{a.preview}</p>}
              </Row>
            ))
          )}
        </Card>
        <Card title="最近新增的文件" icon={<FileText className="size-4" />} more={() => onTab("files")}>
          {new_files.length === 0 ? (
            <Empty>还没有文件</Empty>
          ) : (
            new_files.map((f) => (
              <Row key={f.file_id} onClick={() => void api.openPath(f.path).then(onSeen)}>
                <div className="flex items-center gap-2">
                  <FileIcon name={f.name} />
                  <span className={`truncate ${f.new ? "font-medium" : ""}`}>{f.name}</span>
                  {f.new && <NewDot label={f.updated ? "有新版本" : "新文件"} />}
                  {f.updated && <span className="shrink-0 rounded bg-info-soft px-1.5 text-[11px] text-info">已更新</span>}
                  <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(f.date, false)}</span>
                  <button
                    title={`在 ${fileManager} 中显示`}
                    aria-label={`在 ${fileManager} 中显示`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.openPath(f.path, { reveal: true });
                    }}
                    className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
                  >
                    <FolderOpen className="size-3.5" />
                  </button>
                </div>
              </Row>
            ))
          )}
        </Card>
        {counts.grades && (
          <Card title="成绩" icon={<Award className="size-4" />} more={() => onTab("grades")}>
            {grades.total && (
              <div className="px-2 pt-1 pb-2">
                <TotalLine total={grades.total} />
                <p className="mt-0.5 text-xs text-muted">当前总评（只算已评分的作业）</p>
              </div>
            )}
            {grades.recent.length > 0 && <h3 className="px-2 pt-1 text-[11px] font-medium text-muted">最近评分</h3>}
            {grades.recent.map((a) => (
              <Row key={a.id} onClick={() => onOpen("assignment", a.id)}>
                <div className="flex items-center gap-2">
                  <span className="truncate">{a.title}</span>
                  <span className="ml-auto flex shrink-0 gap-1"><SubmissionBadges a={a} /></span>
                </div>
              </Row>
            ))}
          </Card>
        )}
        <Card title="链接" icon={<ExternalLink className="size-4" />} className={counts.grades ? "lg:col-span-2" : ""}>
          <div className={counts.grades ? "flex flex-wrap" : ""}>
            {counts.syllabus && (
              <Row onClick={() => onTab("syllabus")}>
                <span className="flex items-center gap-2"><ScrollText className="size-4 text-muted" />课程大纲</span>
              </Row>
            )}
            <Row onClick={() => void api.openUrl(`/courses/${course.id}`)}>
              <span className="flex items-center gap-2"><ExternalLink className="size-4 text-muted" />在 Canvas 中打开</span>
            </Row>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, icon, more, className = "", children }: {
  title: string;
  icon: React.ReactNode;
  more?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`}>
      <header className="flex items-center gap-2 px-4 pt-3 pb-1.5 text-sm font-medium">
        <span className="text-muted">{icon}</span>
        {title}
        {more && <button onClick={more} className="ml-auto text-xs font-normal text-muted hover:text-fg">全部 ›</button>}
      </header>
      <div className="px-2 pb-2">{children}</div>
    </section>
  );
}

function Row({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === "Enter" && onClick()} className="cursor-default rounded-md px-2 py-1.5 text-sm hover:bg-chip">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-3 text-sm text-muted">{children}</p>;
}

function Due({ iso }: { iso: string | null | undefined }) {
  const due = untilDue(iso);
  if (!due) return <span className="text-xs text-muted">没有截止日期</span>;
  return (
    <span className={`text-xs ${due.urgent ? "font-medium text-warn" : "text-muted"}`}>
      {shortDate(iso)} · {due.text}
    </span>
  );
}

function AssignmentRow({ a, onClick }: { a: ItemSummary; onClick: () => void }) {
  return (
    <Row onClick={onClick}>
      <div className="flex items-center gap-2">
        {a.new && <NewDot label="新作业" />}
        <span className={`truncate ${a.new ? "font-medium" : ""}`}>{a.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5"><SubmissionBadges a={a} quiet /><Due iso={a.due_at} /></span>
      </div>
    </Row>
  );
}

// -- 模块 ----------------------------------------------------------------------------------

const ITEM_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  Page: BookOpen, Assignment: ClipboardList, Quiz: ListChecks, Discussion: MessagesSquare,
  ExternalUrl: Link, ExternalTool: AppWindow,
};

/** The course as the instructor laid it out. Opens with the current modules expanded
 * (newest upload, next deadline); what you expand or collapse is remembered per course. */
export function CourseModules({ course, version, onOpenDoc, onShowFolder }: {
  course: Course;
  version: number;
  onOpenDoc: (kind: DocKind, id: string) => void;
  onShowFolder: (path: string) => void;
}) {
  const [list, setList] = useState<Module[] | null>(null);
  const [open, setOpen] = usePref<number[] | null>(`modules-open:${course.id}`, null);
  useEffect(() => {
    api.modules(course.id).then(setList, () => setList([]));
  }, [course.id, version]);

  const expanded = new Set(open ?? (list ?? []).filter((m) => m.current).map((m) => m.id));
  const toggle = (id: number) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    setOpen([...next]);
  };

  const activate = (it: ModuleItem) => {
    if (it.file) void api.openPath(it.file);
    else if (it.doc) onOpenDoc(it.doc.kind, it.doc.id);
    else if (it.external) void api.openExternal(it.external);
    else if (it.url) void api.openUrl(it.url);
  };

  if (list === null) return <p className="px-6 py-8 text-sm text-muted">正在加载…</p>;
  if (list.length === 0) {
    return <p className="px-6 py-8 text-sm text-muted">还没有模块。（新加的课程同步一次后就会显示。）</p>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-4">
        <div className="mb-2 flex justify-end gap-3 text-xs text-muted">
          <button className="hover:text-fg" onClick={() => setOpen(list.map((m) => m.id))}>全部展开</button>
          <button className="hover:text-fg" onClick={() => setOpen([])}>全部收起</button>
        </div>
        {list.map((m) => {
          const isOpen = expanded.has(m.id);
          const locked = m.state === "locked";
          return (
            <section key={m.id} className="mb-2 rounded-xl border border-line bg-panel">
              <header className="group flex items-center gap-2 px-3 py-2">
                <button onClick={() => toggle(m.id)} aria-expanded={isOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />}
                  <span className="truncate font-medium">{m.name}</span>
                  {m.current && <span className="shrink-0 rounded bg-info-soft px-1.5 text-[11px] text-info">当前</span>}
                  {locked && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                      <Lock className="size-3" />{m.unlock_at ? `${shortDate(m.unlock_at)} 解锁` : "未解锁"}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted">{m.items.filter((i) => i.type !== "SubHeader").length} 项</span>
                </button>
                {m.folder && (
                  <button
                    title="在“文件”中查看这个模块的文件夹"
                    onClick={() => onShowFolder(m.folder!)}
                    className="shrink-0 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-chip hover:text-fg focus:opacity-100"
                  >
                    <FolderOpen className="size-4" />
                  </button>
                )}
              </header>
              {isOpen && (
                <ul className="border-t border-line px-2 py-1">
                  {m.items.length === 0 && <li className="px-2 py-2 text-sm text-muted">空的</li>}
                  {m.items.map((it, i) => <ModuleRow key={it.id ?? i} it={it} onClick={() => activate(it)} />)}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ModuleRow({ it, onClick }: { it: ModuleItem; onClick: () => void }) {
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
        style={pad}
        title={it.deleted ? "你删除了这个文件；在 Canvas 中打开" : leavesApp ? "在浏览器中打开" : undefined}
        className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm hover:bg-chip ${it.deleted ? "opacity-55" : ""}`}
      >
        {it.type === "File" ? <FileIcon name={it.title} /> : Icon ? <Icon className="size-4 shrink-0 text-muted" /> : <FileText className="size-4 shrink-0 text-muted" />}
        <span className={`truncate ${it.deleted ? "line-through" : ""} ${it.new ? "font-medium" : ""}`}>{it.title}</span>
        {it.new && <NewDot />}
        {it.done && <Check className="size-3.5 shrink-0 text-type-sheet" aria-label="已完成" />}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {it.due_at && <Due iso={it.due_at} />}
          {leavesApp && <ExternalLink className="size-3.5 text-muted" aria-label="在浏览器中打开" />}
        </span>
      </button>
    </li>
  );
}

// -- 公告 / 作业 / 页面 / 大纲 --------------------------------------------------------------

/** A list on the left, the selected item on the right, like a mail client. */
export function CourseReader({ course, tab, selected, version, onSelect, onNavigate, onSeen }: {
  course: Course;
  tab: CourseTab;
  selected: string | null;
  version: number;
  onSelect: (id: string) => void;
  onNavigate: (to: CourseLink) => void;
  onSeen: () => void;
}) {
  const kind = KIND_OF_TAB[tab]!;
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  // Opened here: no dot, even if the list was fetched before opening it marked it seen.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  useEffect(() => {
    setItems(null);
    api.items(course.id, kind).then(setItems, () => setItems([]));
  }, [course.id, kind, version]);
  const list = useMemo(() => items && items.map((x) => (x.new && opened.has(x.id) ? { ...x, new: false } : x)), [items, opened]);

  // Nothing chosen yet: the newest announcement, the next assignment, the front page.
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
      <ul className="w-80 shrink-0 overflow-y-auto border-r border-line p-2" aria-label="列表">
        {list === null && <li className="px-2 py-3 text-sm text-muted">正在加载…</li>}
        {list?.length === 0 && <li className="px-2 py-3 text-sm text-muted">什么都没有</li>}
        {kind === "assignment" ? <AssignmentList list={list ?? []} current={current} onSelect={onSelect} /> : (list ?? []).map((it) => (
          <ListRow key={it.id} it={it} active={it.id === current} onClick={() => onSelect(it.id)} />
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

function ListRow({ it, active, onClick }: { it: ItemSummary; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button onClick={onClick} className={`block w-full rounded-md px-2.5 py-2 text-left ${active ? "bg-selected" : "hover:bg-chip"}`}>
        <div className="flex items-center gap-2">
          {it.new && <NewDot />}
          <span className={`truncate text-sm ${it.new ? "font-medium" : ""}`}>{it.title}</span>
          {it.front_page && <span className="shrink-0 rounded bg-chip px-1 text-[10px] text-muted">首页</span>}
          <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(it.date, false)}</span>
        </div>
        {it.preview && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{it.preview}</p>}
        {it.author && !it.preview && <p className="mt-0.5 text-xs text-muted">{it.author}</p>}
      </button>
    </li>
  );
}

function AssignmentList({ list, current, onSelect }: { list: ItemSummary[]; current: string | null; onSelect: (id: string) => void }) {
  const groups = useMemo(() => {
    const now = Date.now();
    const g: [string, ItemSummary[]][] = [["即将截止", []], ["已过截止", []], ["没有截止日期", []]];
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
                <button onClick={() => onSelect(a.id)} className={`block w-full rounded-md px-2.5 py-2 text-left ${a.id === current ? "bg-selected" : "hover:bg-chip"}`}>
                  <div className="flex items-center gap-2">
                    {a.new && <NewDot />}
                    <span className={`truncate text-sm ${a.new ? "font-medium" : ""}`}>{a.title}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Due iso={a.due_at} />
                    {a.points != null && a.status !== "graded" && <span className="text-xs text-muted">· {fmt(a.points)} 分</span>}
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
  online_upload: "上传文件", online_text_entry: "在线文本", online_url: "网址", online_quiz: "测验",
  discussion_topic: "讨论", external_tool: "外部工具", on_paper: "纸质", none: "不需要提交", media_recording: "录音/录像",
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
        <p>在已同步的内容里找不到它（可能是新的，或者不是公告）。</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-2 text-accent hover:underline">在 Canvas 中打开这门课</button>
      </div>
    );
  }
  if (!it) return <p className="p-8 text-sm text-muted">正在加载…</p>;
  const submit = kind === "assignment" && it.submission_types?.some((t) => t.startsWith("online") || t === "external_tool");
  return (
    <article className="mx-auto max-w-3xl px-8 py-6">
      <header className="mb-4 border-b border-line pb-4">
        <h1 className="selectable text-xl font-semibold">{kind === "syllabus" ? "课程大纲" : it.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {kind === "announcement" && <>{it.author && <span>{it.author}</span>}<span>{shortDate(it.date)}</span></>}
          {kind === "assignment" && (
            <>
              <Due iso={it.due_at} />
              {it.points != null && <span>{fmt(it.points)} 分</span>}
              {!!it.submission_types?.length && <span>{it.submission_types.map((t) => SUBMISSION[t] ?? t).join("、")}</span>}
              <span className="flex items-center gap-1"><SubmissionBadges a={it} /></span>
              {it.submitted_at && <span>提交于 {shortDate(it.submitted_at)}</span>}
            </>
          )}
          {kind === "page" && it.date && <span>更新于 {shortDate(it.date)}</span>}
          {it.url && (
            <button onClick={() => void api.openUrl(it.url!)} className="ml-auto flex items-center gap-1 text-accent hover:underline">
              {submit ? "在 Canvas 中提交" : "在 Canvas 中打开"}
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
        <p className="text-sm text-muted">没有正文。</p>
      )}
    </article>
  );
}

// -- 成绩 ----------------------------------------------------------------------------------

/** Your total as Canvas computes it, and every assignment's grade, latest due first. */
export function CourseGrades({ course, version, onOpenDoc }: {
  course: Course;
  version: number;
  onOpenDoc: (kind: DocKind, id: string) => void;
}) {
  const [g, setG] = useState<Grades | null>(null);
  useEffect(() => {
    api.grades(course.id).then(setG, () => setG({ total: null, assignments: [] }));
  }, [course.id, version]);
  if (!g) return <p className="px-6 py-8 text-sm text-muted">正在加载…</p>;
  const { total } = g;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <section className="mb-5 rounded-xl border border-line bg-panel px-5 py-4">
          {total ? (
            <>
              <p className="mb-1 text-xs text-muted">当前总评</p>
              <TotalLine total={total} big />
              <p className="mt-1.5 text-xs text-muted">
                只算已经评分的作业，按 Canvas 的计算方式；每次同步时更新。
                {total.final_score != null && total.final_score !== total.current_score && (
                  <> 未评分的都按 0 分算的话是 {fmt(total.final_score)}%。</>
                )}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">这门课在 Canvas 上不显示总评。</p>
          )}
        </section>
        {g.assignments.length === 0 ? (
          <p className="text-sm text-muted">还没有作业。</p>
        ) : (
          <ul className="rounded-xl border border-line bg-panel p-1.5">
            <li className="grid grid-cols-[minmax(0,1fr)_9rem_minmax(7rem,auto)] gap-3 px-2.5 py-1.5 text-[11px] font-medium text-muted">
              <span>作业</span><span>截止</span><span className="text-right">成绩</span>
            </li>
            {g.assignments.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => onOpenDoc("assignment", a.id)}
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
