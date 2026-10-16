// A course's page: tabs (概览 first), the overview, and readers for announcements,
// assignments, pages, the syllabus and grades. The 文件 tab is the file browser, rendered
// by the main window. A blue dot marks what's new to you; opening it clears the dot.
import {
  AppWindow, Award, BookOpen, Check, ChevronDown, ChevronRight, ClipboardList, ExternalLink, FileText, FolderOpen, Link, ListChecks, Lock,
  Megaphone, MessagesSquare, Paperclip, ScrollText, SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import type { Course, DocKind, Grades, Item, ItemSummary, LaunchTarget, Module, ModuleItem, NewCounts, Overview, Total } from "../lib/api";
import { usePref } from "../lib/prefs";
import { useSearch } from "../lib/useSearch";
import { shortDate, untilDue } from "../lib/dates";
import { DropMark, moved, useReorder, type Mark } from "../lib/reorder";
import { FileIcon } from "./FileIcon";
import type { MenuItem } from "./Menu";
import { Count, NewDot } from "./Status";
import { RichText, type CourseLink } from "./RichText";
import { t } from "../lib/i18n";

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

/** Open external tools; `pending` is the one on its way (asking Canvas for a link takes a moment). */
function useLaunch(courseId: number) {
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

/** Every tab, in the order you dragged them into (any you never placed go at the end). */
export function arrangeTabs(saved: string[]): CourseTab[] {
  const placed = saved.filter((x): x is CourseTab => (DEFAULT_TABS as string[]).includes(x));
  return [...placed, ...DEFAULT_TABS.filter((x) => !placed.includes(x))];
}

/** `all` with the items of `subset` (in it) put back in the order of `reordered`; the rest stay put. */
function refill<T>(all: T[], subset: T[], reordered: T[]): T[] {
  const queue = [...reordered];
  return all.map((x) => (subset.includes(x) ? queue.shift()! : x));
}

/** A course's tabs. Drag to reorder, right-click to hide (in every course). Tabs with nothing
 * in them aren't shown; 概览 and 文件 always are, unless you hid them. */
export function CourseTabs({ tab, overview, order, hidden, onTab, onMarkAllSeen, onArrange, onMenu }: {
  tab: CourseTab;
  overview: Overview | null;
  order: CourseTab[];
  hidden: CourseTab[];
  onTab: (t: CourseTab) => void;
  onMarkAllSeen: () => void;
  onArrange: (order: CourseTab[], hidden: CourseTab[]) => void;
  onMenu: (items: MenuItem[], x: number, y: number) => void;
}) {
  const c = overview?.counts;
  const n = overview?.new;
  const has: Record<CourseTab, boolean> = {
    overview: true, modules: !!c?.modules, announcements: !!c?.announcements, assignments: !!c?.assignments,
    grades: !!c?.grades, files: true, syllabus: !!c?.syllabus, pages: !!c?.pages,
  };
  const fresh: Partial<Record<CourseTab, number>> = {
    announcements: n?.announcements, assignments: n?.assignments, files: n?.files, pages: n?.pages,
  };
  const visible = order.filter((id) => !hidden.includes(id) && (has[id] || id === tab));
  const drag = useReorder(visible.length, (from, to) => onArrange(refill(order, visible, moved(visible, from, to)), hidden), "x");

  const menu = (id: CourseTab | null): MenuItem[] => {
    const showAgain: MenuItem[] = hidden.map((h) => ({
      label: t("显示“{name}”标签", { name: TAB_LABEL[h] }), onSelect: () => onArrange(order, hidden.filter((x) => x !== h)),
    }));
    const usual = hidden.length === 0 && order.every((x, i) => x === DEFAULT_TABS[i]);
    const items: MenuItem[] = [
      ...(id ? [{
        label: t("隐藏“{name}”标签", { name: TAB_LABEL[id] }),
        disabled: order.filter((x) => !hidden.includes(x)).length <= 1,
        onSelect: () => onArrange(order, [...hidden, id]),
      }] : []),
      ...(showAgain.length ? ["separator" as const, ...showAgain] : []),
      "separator",
      { label: t("恢复默认的标签"), disabled: usual, onSelect: () => onArrange(DEFAULT_TABS, []) },
    ];
    while (items[0] === "separator") items.shift(); // (no tab under the pointer: nothing to hide)
    return items;
  };

  return (
    <nav
      className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-4"
      aria-label={t("课程")}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onMenu(menu(null), e.clientX, e.clientY);
      }}
    >
      {visible.map((id, i) => (
        <button
          key={id}
          {...drag.item(i)}
          onClick={() => onTab(id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu(menu(id), e.clientX, e.clientY);
          }}
          aria-current={tab === id ? "page" : undefined}
          className={`relative -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${tab === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"} ${drag.dragging === i ? "opacity-40" : ""}`}
        >
          <DropMark at={drag.mark(i)} axis="x" />
          {TAB_LABEL[id]}
          {!!fresh[id] && <Count n={fresh[id]!} label={t("{n} 个新的", { n: fresh[id]! })} />}
        </button>
      ))}
      {totalNew(n) > 0 && (
        <button onClick={onMarkAllSeen} className="ml-auto shrink-0 py-2 text-xs text-muted hover:text-fg" title={t("清除这门课所有的“新”标记")}>
          {t("全部标为已读")}
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

function TotalLine({ total, big = false }: { total: Total; big?: boolean }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className={`${big ? "text-3xl" : "text-xl"} font-semibold tabular-nums`}>{fmt(total.current_score)}%</span>
      {total.current_grade && <span className={`${big ? "text-lg" : "text-sm"} font-medium text-fg-soft`}>{total.current_grade}</span>}
    </span>
  );
}

// -- 概览 --------------------------------------------------------------------------------

export type OverviewCard = "upcoming" | "announcements" | "modules" | "files" | "grades" | "links";
export const DEFAULT_CARDS: OverviewCard[] = ["upcoming", "announcements", "modules", "files", "grades", "links"];
const CARD_LABEL: Record<OverviewCard, string> = {
  upcoming: t("近期截止"), announcements: t("最新公告"), modules: t("当前模块"), files: t("最近新增的文件"),
  grades: t("成绩"), links: t("工具与链接"),
};

/** Every card, in the order you dragged them into (any you never placed go at the end). */
export function arrangeCards(saved: string[]): OverviewCard[] {
  const placed = saved.filter((x): x is OverviewCard => (DEFAULT_CARDS as string[]).includes(x));
  return [...placed, ...DEFAULT_CARDS.filter((x) => !placed.includes(x))];
}

/** What a course page opens with: cards for what's due, what was said, this week's module,
 * what's new in its files, grades, and its tools. Drag a card by its title to move it; choose
 * which to show under 自定义 (or right-click a title). The same in every course. */
export function CourseOverview({ course, overview, cards, hiddenCards, onArrange, onMenu, onOpen, onTab, onSeen, onShowFile, onMarkSeen }: {
  course: Course;
  overview: Overview | null;
  cards: OverviewCard[];
  hiddenCards: OverviewCard[];
  onArrange: (order: OverviewCard[], hidden: OverviewCard[]) => void;
  onMenu: (items: MenuItem[], x: number, y: number) => void;
  onOpen: (kind: DocKind, id: string) => void;
  onTab: (t: CourseTab) => void;
  onSeen: () => void;
  onShowFile: (path: string) => void; // in its folder, in the app
  onMarkSeen: (kinds: ("announcement" | "assignment" | "file")[]) => void;
}) {
  const { launch, pending } = useLaunch(course.id);
  const available: Record<OverviewCard, boolean> = {
    upcoming: true, announcements: true, modules: !!overview?.current_modules.length, files: true,
    grades: !!overview?.counts.grades, links: true,
  };
  const shown = cards.filter((c) => !hiddenCards.includes(c) && available[c]);
  const drag = useReorder(shown.length, (from, to) => onArrange(refill(cards, shown, moved(shown, from, to)), hiddenCards), "cards");
  // Two columns when there's room, each card as tall as what's in it: 1st, 3rd, 5th... on the left.
  const [grid, setGrid] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    if (!grid) return;
    const observer = new ResizeObserver(([e]) => setColumns(e.contentRect.width >= 760 ? 2 : 1));
    observer.observe(grid);
    return () => observer.disconnect();
  }, [grid]);

  if (!overview) return <p className="px-6 py-8 text-sm text-muted">{t("正在加载…")}</p>;
  const { upcoming, announcements, new_files, counts, grades, tools, current_modules } = overview;
  const empty = !counts.announcements && !counts.assignments && !counts.pages && !counts.files && !counts.syllabus;
  if (empty) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-sm text-fg-soft">
        <p className="mb-2 text-base text-fg">{t("这门课在 Canvas 上几乎没有内容。")}</p>
        <p className="text-muted">{t("很多课程把材料放在课程网站、Ed 或 Gradescope 上。")}</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-4 text-accent hover:underline">{t("在 Canvas 中打开这门课")}</button>
      </div>
    );
  }

  const customize = (): MenuItem[] => [
    ...cards.map((c): MenuItem => ({
      label: CARD_LABEL[c],
      checked: !hiddenCards.includes(c),
      hint: available[c] ? undefined : t("这门课没有"),
      onSelect: () => onArrange(cards, hiddenCards.includes(c) ? hiddenCards.filter((x) => x !== c) : [...hiddenCards, c]),
    })),
    "separator",
    {
      label: t("恢复默认的概览"),
      disabled: !hiddenCards.length && cards.every((c, i) => c === DEFAULT_CARDS[i]),
      onSelect: () => onArrange(DEFAULT_CARDS, []),
    },
  ];
  const cardMenu = (c: OverviewCard): MenuItem[] => [
    { label: t("隐藏“{name}”", { name: CARD_LABEL[c] }), onSelect: () => onArrange(cards, [...hiddenCards, c]) },
    "separator",
    ...customize(),
  ];
  const markRead = (n: number, kinds: ("announcement" | "assignment" | "file")[]) =>
    n > 0 ? { label: t("标为已读"), onClick: () => onMarkSeen(kinds) } : undefined;
  const activate = (it: ModuleItem) => {
    if (it.file) void api.openPath(it.file).then(onSeen);
    else if (it.doc) onOpen(it.doc.kind, it.doc.id);
    else if (it.external) void api.openExternal(it.external);
    else if (it.tool) launch(`item:${it.tool.module_item_id}`, { module_item_id: it.tool.module_item_id });
    else if (it.url) void api.openUrl(it.url);
  };

  const body: Record<OverviewCard, () => React.ReactNode> = {
    upcoming: () =>
      upcoming.length === 0 ? <Empty>{t("接下来三周没有要交的作业")}</Empty>
        : upcoming.map((a) => <AssignmentRow key={a.id} a={a} onClick={() => onOpen("assignment", a.id)} />),
    announcements: () =>
      announcements.length === 0 ? <Empty>{t("还没有公告")}</Empty> : announcements.map((a) => (
        <Row key={a.id} onClick={() => onOpen("announcement", a.id)}>
          <div className="flex items-center gap-2">
            {a.new && <NewDot label={t("新公告")} />}
            <span className={`truncate ${a.new ? "font-medium" : ""}`}>{a.title}</span>
            <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(a.date, false)}</span>
          </div>
          {a.preview && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{a.preview}</p>}
        </Row>
      )),
    modules: () => current_modules.map((m) => (
      <div key={m.id}>
        <h3 className="truncate px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted">{m.name}</h3>
        <ul>
          {m.items.slice(0, 10).map((it, i) => (
            <ModuleRow key={it.id ?? i} it={{ ...it, indent: 0 }} opening={!!it.tool && pending === `item:${it.tool.module_item_id}`} onClick={() => activate(it)} />
          ))}
        </ul>
        {m.items.length > 10 && (
          <button onClick={() => onTab("modules")} className="px-2 py-1 text-xs text-muted hover:text-fg">{t("还有 {n} 项 ›", { n: m.items.length - 10 })}</button>
        )}
      </div>
    )),
    files: () =>
      new_files.length === 0 ? <Empty>{t("还没有文件")}</Empty> : new_files.map((f) => (
        <Row key={f.file_id} onClick={() => void api.openPath(f.path).then(onSeen)}>
          <div className="flex items-center gap-2">
            <FileIcon name={f.name} />
            <span className={`truncate ${f.new ? "font-medium" : ""}`}>{f.name}</span>
            {f.new && <NewDot label={f.updated ? t("有新版本") : t("新文件")} />}
            {f.updated && <span className="shrink-0 rounded bg-info-soft px-1.5 text-[11px] text-info">{t("已更新")}</span>}
            <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(f.date, false)}</span>
            <button
              title={t("在文件夹中显示")}
              aria-label={t("在文件夹中显示")}
              onClick={(e) => {
                e.stopPropagation();
                onShowFile(f.path);
              }}
              className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
            >
              <FolderOpen className="size-3.5" />
            </button>
          </div>
        </Row>
      )),
    grades: () => (
      <>
        {grades.total && (
          <div className="px-2 pt-1 pb-2">
            <TotalLine total={grades.total} />
            <p className="mt-0.5 text-xs text-muted">{t("当前总评（只算已评分的作业）")}</p>
          </div>
        )}
        {grades.recent.length > 0 && <h3 className="px-2 pt-1 text-[11px] font-medium text-muted">{t("最近评分")}</h3>}
        {grades.recent.map((a) => (
          <Row key={a.id} onClick={() => onOpen("assignment", a.id)}>
            <div className="flex items-center gap-2">
              <span className="truncate">{a.title}</span>
              <span className="ml-auto flex shrink-0 gap-1"><SubmissionBadges a={a} /></span>
            </div>
          </Row>
        ))}
      </>
    ),
    links: () => (
      <div className="flex flex-wrap">
        {tools.map((tool) => (
          <Row key={tool.id} onClick={() => launch(`tool:${tool.id}`, { tool_id: tool.id })}>
            <span className="flex items-center gap-2" title={tool.label ? t("在浏览器中打开 {name}（通过 Canvas 登录）", { name: tool.label }) : t("在浏览器中打开这个工具（通过 Canvas 登录）")}>
              <AppWindow className="size-4 text-muted" />
              {tool.label ?? t("外部工具")}
              {pending === `tool:${tool.id}` && <span className="text-xs text-muted">{t("正在打开…")}</span>}
            </span>
          </Row>
        ))}
        {counts.syllabus && (
          <Row onClick={() => onTab("syllabus")}>
            <span className="flex items-center gap-2"><ScrollText className="size-4 text-muted" />{t("课程大纲")}</span>
          </Row>
        )}
        <Row onClick={() => void api.openUrl(`/courses/${course.id}`)}>
          <span className="flex items-center gap-2"><ExternalLink className="size-4 text-muted" />{t("在 Canvas 中打开")}</span>
        </Row>
      </div>
    ),
  };
  const head: Record<OverviewCard, { icon: React.ReactNode; more?: () => void; action?: { label: string; onClick: () => void } }> = {
    upcoming: { icon: <ClipboardList className="size-4" />, more: counts.assignments ? () => onTab("assignments") : undefined, action: markRead(overview.new.assignments, ["assignment"]) },
    announcements: { icon: <Megaphone className="size-4" />, more: counts.announcements ? () => onTab("announcements") : undefined, action: markRead(overview.new.announcements, ["announcement"]) },
    modules: { icon: <ListChecks className="size-4" />, more: () => onTab("modules") },
    files: { icon: <FileText className="size-4" />, more: () => onTab("files"), action: markRead(overview.new.files, ["file"]) },
    grades: { icon: <Award className="size-4" />, more: () => onTab("grades") },
    links: { icon: <ExternalLink className="size-4" /> },
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pt-3 pb-6">
        <div className="mb-2 flex justify-end">
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(customize(), r.right - 220, r.bottom + 4);
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-chip hover:text-fg"
          >
            <SlidersHorizontal className="size-3.5" />
            {t("自定义概览")}
          </button>
        </div>
        {shown.length === 0 && <p className="py-10 text-center text-sm text-muted">{t("所有卡片都隐藏了。点右上角的“自定义概览”选几张。")}</p>}
        <div ref={setGrid} className="flex items-start gap-4">
          {Array.from({ length: columns }, (_, col) => (
            <div key={col} className="flex min-w-0 flex-1 flex-col gap-4">
              {shown.map((c, i) => i % columns === col && (
                <Card
                  key={c}
                  cardRef={drag.ref(i)}
                  grab={drag.handle(i)}
                  mark={drag.mark(i)}
                  dragging={drag.dragging === i}
                  title={c === "links" && !tools.length ? t("链接") : CARD_LABEL[c]}
                  onMenu={(x, y) => onMenu(cardMenu(c), x, y)}
                  {...head[c]}
                >
                  {body[c]()}
                </Card>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({ title, icon, more, action, cardRef, grab, mark, dragging, onMenu, children }: {
  title: string;
  icon: React.ReactNode;
  more?: () => void;
  action?: { label: string; onClick: () => void };
  cardRef: (el: HTMLElement | null) => void;
  grab: { onPointerDown: (e: React.PointerEvent) => void };
  mark: Mark;
  dragging: boolean;
  onMenu: (x: number, y: number) => void;
  children: React.ReactNode;
}) {
  return (
    <section ref={cardRef} className={`relative rounded-xl border border-line bg-panel ${dragging ? "opacity-40" : ""}`}>
      <DropMark at={mark} axis="cards" />
      <header
        {...grab}
        onContextMenu={(e) => (e.preventDefault(), onMenu(e.clientX, e.clientY))}
        title={t("拖动标题可以移动卡片，右键可以隐藏")}
        className="flex cursor-grab items-center gap-2 px-4 pt-3 pb-1.5 text-sm font-medium active:cursor-grabbing"
      >
        <span className="text-muted">{icon}</span>
        {title}
        <span className="ml-auto flex items-center gap-3 text-xs font-normal">
          {action && <button onClick={action.onClick} className="text-muted hover:text-fg">{action.label}</button>}
          {more && <button onClick={more} className="text-muted hover:text-fg">{t("全部 ›")}</button>}
        </span>
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
  if (!due) return <span className="text-xs text-muted">{t("没有截止日期")}</span>;
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
export function CourseModules({ course, version, onOpenDoc, onShowFolder, query, onWiden }: {
  course: Course;
  version: number;
  onOpenDoc: (kind: DocKind, id: string) => void;
  onShowFolder: (path: string) => void;
  query: string; // the search box: only items (or modules) with these words in their titles
  onWiden: () => void;
}) {
  const [list, setList] = useState<Module[] | null>(null);
  const [open, setOpen] = usePref<number[] | null>(`modules-open:${course.id}`, null);
  const { launch, pending } = useLaunch(course.id);
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
    else if (it.tool) launch(`item:${it.tool.module_item_id}`, { module_item_id: it.tool.module_item_id });
    else if (it.url) void api.openUrl(it.url);
  };

  if (list === null) return <p className="px-6 py-8 text-sm text-muted">{t("正在加载…")}</p>;
  if (list.length === 0) {
    return <p className="px-6 py-8 text-sm text-muted">{t("还没有模块。（新加的课程同步一次后就会显示。）")}</p>;
  }
  // Searching: modules whose name matches, whole; elsewhere just the matching items; all open.
  const match = matcher(query);
  const shown = match
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
        {match ? (
          <FilterNote n={found} onWiden={onWiden} />
        ) : (
          <div className="mb-2 flex justify-end gap-3 text-xs text-muted">
            <button className="hover:text-fg" onClick={() => setOpen(list.map((m) => m.id))}>{t("全部展开")}</button>
            <button className="hover:text-fg" onClick={() => setOpen([])}>{t("全部收起")}</button>
          </div>
        )}
        {shown.map((m) => {
          const isOpen = !!match || expanded.has(m.id);
          const locked = m.state === "locked";
          return (
            <section key={m.id} className="mb-2 rounded-xl border border-line bg-panel">
              <header className="group flex items-center gap-2 px-3 py-2">
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
                    <ModuleRow key={it.id ?? i} it={it} opening={!!it.tool && pending === `item:${it.tool.module_item_id}`} onClick={() => activate(it)} />
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

function ModuleRow({ it, opening, onClick }: { it: ModuleItem; opening: boolean; onClick: () => void }) {
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
          {it.front_page && <span className="shrink-0 rounded bg-chip px-1 text-[10px] text-muted">{t("首页")}</span>}
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
                <button onClick={() => onSelect(a.id)} className={`block w-full rounded-md px-2.5 py-2 text-left ${a.id === current ? "bg-selected" : "hover:bg-chip"}`}>
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
