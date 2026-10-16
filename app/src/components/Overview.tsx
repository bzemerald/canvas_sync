// A course's overview: cards, arranged for the course. Built in: what's due, what was said,
// this week's module, new files, grades, tools and links. Added: a folder, a file, a note, a
// page, a module, a saved search, the syllabus, wherever the instructor keeps what matters.
// Drag a card by its title to move it; right-click a title to hide it or change it;
// 自定义概览 adds cards, or makes this course's arrangement every course's default.
import {
  AppWindow, Award, BookOpen, ClipboardList, ExternalLink, FileText, Folder, FolderOpen, Link as LinkIcon, ListChecks,
  Megaphone, NotebookPen, Plus, ScrollText, Search as SearchIcon, SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type { Card as CardSpec, Course, CourseLayout, DocKind, Entry, Hit, Item, Module, ModuleItem, Overview } from "../lib/api";
import { shortDate } from "../lib/dates";
import { t } from "../lib/i18n";
import { DropMark, moved, useReorder, type Mark } from "../lib/reorder";
import { AddCardDialog } from "./AddCardDialog";
import { Button, Dialog } from "./Dialog";
import {
  AssignmentRow, Empty, ModuleRow, Row, SubmissionBadges, TotalLine, refill, useLaunch, type CourseTab,
} from "./CourseView";
import { FileIcon } from "./FileIcon";
import type { MenuItem } from "./Menu";
import { RenameDialog } from "./RenameDialog";
import { RichText, type CourseLink } from "./RichText";
import { NewDot } from "./Status";
import { Thumb } from "./Thumb";

export const BUILT_IN = ["upcoming", "announcements", "modules", "files", "grades", "links"] as const;
const BUILT_IN_LABEL: Record<string, string> = {
  upcoming: t("近期截止"), announcements: t("最新公告"), modules: t("当前模块"), files: t("最近新增的文件"),
  grades: t("成绩"), links: t("工具与链接"),
};
const keyOf = (c: CardSpec) => c.id ?? c.type;
const GAP = 16; // px between cards
const isBuiltIn = (c: CardSpec) => (BUILT_IN as readonly string[]).includes(c.type);

type Kinds = ("announcement" | "assignment" | "file")[];

export function CourseOverview({
  course, overview, layout, onLayout, onReset, onMakeDefault, onMenu, onOpen, onOpenHit, onTab, onNavigate, onSeen, onShowFile,
  onShowFolder, onMarkSeen,
}: {
  course: Course;
  overview: Overview | null;
  layout: CourseLayout | null;
  onLayout: (changes: Partial<Pick<CourseLayout, "cards" | "hidden_links" | "links">>) => void;
  onReset: () => void; // back to the default arrangement (cards added stay)
  onMakeDefault: () => void; // this arrangement for every course that doesn't have its own
  onMenu: (items: MenuItem[], x: number, y: number) => void;
  onOpen: (kind: DocKind, id: string) => void;
  onOpenHit: (hit: Hit) => void;
  onTab: (t: CourseTab) => void;
  onNavigate: (to: CourseLink) => void;
  onSeen: () => void;
  onShowFile: (path: string) => void; // in its folder, in the app
  onShowFolder: (path: string) => void;
  onMarkSeen: (kinds: Kinds) => void;
}) {
  const { launch, pending } = useLaunch(course.id);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<CardSpec | null>(null);
  const [addingLink, setAddingLink] = useState(false);
  // Two columns when there's room. Cards go in order, each into whichever column is shorter so
  // far, so the two come out about even. They're positioned in one box rather than put in two:
  // a card that ends up in the other column slides over instead of being built again.
  const [grid, setGrid] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState(2);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [placed, setPlaced] = useState(false); // laid out once: from now on, moves slide
  const [fresh, setFresh] = useState<string | null>(null); // a card just added: scrolled to, outlined
  const sizes = useRef<ResizeObserver | null>(null);
  const watched = useRef(new WeakSet<Element>());
  const measure = useCallback(() => {
    if (!grid) return;
    const next: Record<string, number> = {};
    for (const el of Array.from(grid.children) as HTMLElement[]) if (el.dataset.card) next[el.dataset.card] = el.offsetHeight;
    setHeights((h) => (Object.keys(h).length === Object.keys(next).length && Object.keys(next).every((k) => h[k] === next[k]) ? h : next));
  }, [grid]);
  useEffect(() => {
    if (!grid) return;
    const observer = new ResizeObserver(() => {
      setColumns(grid.clientWidth >= 760 ? 2 : 1);
      measure();
    });
    [grid, ...Array.from(grid.children)].forEach((el) => observer.observe(el));
    sizes.current = observer;
    watched.current = new WeakSet(Array.from(grid.children));
    return () => {
      observer.disconnect();
      sizes.current = null;
    };
  }, [grid, measure]);
  // Every render: watch cards that just appeared, and place them before anything is drawn.
  useLayoutEffect(() => {
    if (!grid) return;
    for (const el of Array.from(grid.children)) {
      if (sizes.current && !watched.current.has(el)) {
        watched.current.add(el);
        sizes.current.observe(el);
      }
    }
    measure();
  });
  useEffect(() => {
    if (placed || !Object.keys(heights).length) return;
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [heights, placed]);
  useEffect(() => {
    if (!fresh || !grid || heights[fresh] === undefined) return;
    (Array.from(grid.children) as HTMLElement[]).find((el) => el.dataset.card === fresh)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = setTimeout(() => setFresh(null), 2000);
    return () => clearTimeout(timer);
  }, [fresh, grid, heights]);

  const cards = layout?.cards ?? [];
  const available = (c: CardSpec) =>
    c.type === "modules" ? !!overview?.current_modules.length
      : c.type === "grades" ? !!overview?.counts.grades
        : c.type === "syllabus" ? !!overview?.counts.syllabus
          : true;
  const shown = cards.filter(available);
  const drag = useReorder(shown.length, (from, to) => onLayout({ cards: refill(cards, shown, moved(shown, from, to)) }), "cards");

  if (!overview || !layout) return <p className="px-6 py-8 text-sm text-muted">{t("正在加载…")}</p>;
  const { upcoming, announcements, new_files, counts, grades, tools, current_modules } = overview;
  const empty = !counts.announcements && !counts.assignments && !counts.pages && !counts.files && !counts.syllabus;
  if (empty && cards.every(isBuiltIn)) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-sm text-fg-soft">
        <p className="mb-2 text-base text-fg">{t("这门课在 Canvas 上几乎没有内容。")}</p>
        <p className="text-muted">{t("很多课程把材料放在课程网站、Ed 或 Gradescope 上。")}</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-4 text-accent hover:underline">{t("在 Canvas 中打开这门课")}</button>
      </div>
    );
  }

  const without = (c: CardSpec) => cards.filter((x) => keyOf(x) !== keyOf(c));
  const customize = (): MenuItem[] => [
    ...BUILT_IN.map((type): MenuItem => {
      const on = cards.some((c) => c.type === type);
      return {
        label: BUILT_IN_LABEL[type],
        checked: on,
        hint: on && !available({ type }) ? t("这门课没有") : undefined,
        onSelect: () => onLayout({ cards: on ? cards.filter((c) => c.type !== type) : [...cards, { type }] }),
      };
    }),
    ...cards.filter((c) => !isBuiltIn(c)).map((c): MenuItem => ({
      label: titleOf(c), checked: true, onSelect: () => onLayout({ cards: without(c) }),
    })),
    "separator",
    { label: t("添加卡片…"), onSelect: () => setAdding(true) },
    "separator",
    { label: t("设为所有课程的默认概览"), onSelect: onMakeDefault },
    { label: t("恢复默认（和其他课程一样）"), disabled: !layout.own_cards, onSelect: onReset },
  ];

  // 工具与链接: the course's tools, its syllabus, Canvas, and links you added; each can be hidden.
  const linkRows: { key: string; label: string; icon: React.ReactNode; open: () => void; mine?: number }[] = [
    ...tools.map((tool) => ({
      key: `tool:${tool.id}`, label: tool.label ?? t("外部工具"), icon: <AppWindow className="size-4 text-muted" />,
      open: () => launch(`tool:${tool.id}`, { tool_id: tool.id }),
    })),
    ...(counts.syllabus ? [{ key: "syllabus", label: t("课程大纲"), icon: <ScrollText className="size-4 text-muted" />, open: () => onTab("syllabus") }] : []),
    { key: "canvas", label: t("在 Canvas 中打开"), icon: <ExternalLink className="size-4 text-muted" />, open: () => void api.openUrl(`/courses/${course.id}`) },
    ...layout.links.map((l, i) => ({
      key: `link:${i}`, label: l.title || l.url, icon: <LinkIcon className="size-4 text-muted" />, open: () => void api.openExternal(l.url), mine: i,
    })),
  ];
  const hiddenLinks = linkRows.filter((r) => layout.hidden_links.includes(r.key));
  const linkMenu = (r: (typeof linkRows)[number]): MenuItem[] =>
    r.mine !== undefined
      ? [{ label: t("删除链接"), danger: true, onSelect: () => onLayout({ links: layout.links.filter((_, i) => i !== r.mine) }) }]
      : [{ label: t("隐藏“{name}”", { name: r.label }), onSelect: () => onLayout({ hidden_links: [...layout.hidden_links, r.key] }) }];

  const cardMenu = (c: CardSpec): MenuItem[] => [
    ...(isBuiltIn(c)
      ? [{ label: t("隐藏“{name}”", { name: titleOf(c) }), onSelect: () => onLayout({ cards: without(c) }) }]
      : [
          ...(c.type !== "syllabus" ? [{ label: t("重命名…"), onSelect: () => setRenaming(c) }] : []),
          { label: t("删除卡片"), danger: true, onSelect: () => onLayout({ cards: without(c) }) },
        ]),
    ...(c.type === "links"
      ? [
          "separator" as const,
          { label: t("添加链接…"), onSelect: () => setAddingLink(true) },
          ...hiddenLinks.map((r) => ({
            label: t("显示“{name}”", { name: r.label }),
            onSelect: () => onLayout({ hidden_links: layout.hidden_links.filter((k) => k !== r.key) }),
          })),
        ]
      : []),
    "separator",
    ...customize(),
  ];

  const titleOf = (c: CardSpec): string =>
    c.title ?? (c.type === "links" && !tools.length ? t("链接")
      : isBuiltIn(c) ? BUILT_IN_LABEL[c.type]
        : c.type === "folder" || c.type === "file" ? (c.path ?? "").split("/").pop() ?? ""
          : c.type === "note" ? t("备忘录")
            : c.type === "search" ? `“${c.query ?? ""}”`
              : c.type === "syllabus" ? t("课程大纲")
                : c.type === "page" ? t("页面@@card")
                  : t("模块@@card"));

  const markRead = (n: number, kinds: Kinds) => (n > 0 ? { label: t("标为已读"), onClick: () => onMarkSeen(kinds) } : undefined);
  const activate = (it: ModuleItem) => {
    if (it.file) void api.openPath(it.file).then(onSeen);
    else if (it.doc) onOpen(it.doc.kind, it.doc.id);
    else if (it.external) void api.openExternal(it.external);
    else if (it.tool) launch(`item:${it.tool.module_item_id}`, { module_item_id: it.tool.module_item_id });
    else if (it.url) void api.openUrl(it.url);
  };
  const moduleItems = (m: Module, limit = 10) => (
    <>
      <ul>
        {m.items.slice(0, limit).map((it, i) => (
          <ModuleRow key={it.id ?? i} it={{ ...it, indent: 0 }} opening={!!it.tool && pending === `item:${it.tool.module_item_id}`} onClick={() => activate(it)} />
        ))}
      </ul>
      {m.items.length > limit && (
        <button onClick={() => onTab("modules")} className="px-2 py-1 text-xs text-muted hover:text-fg">{t("还有 {n} 项 ›", { n: m.items.length - limit })}</button>
      )}
    </>
  );

  // Where each card goes: down the shorter column.
  const tops = Array.from({ length: columns }, () => 0);
  const spots = shown.map((c) => {
    const col = tops.indexOf(Math.min(...tops));
    const top = tops[col];
    tops[col] += (heights[keyOf(c)] ?? 0) + GAP;
    return { col, top };
  });
  const spot = (i: number): React.CSSProperties => ({
    position: "absolute",
    top: spots[i].top,
    left: columns === 1 ? 0 : `calc(${spots[i].col} * (50% + ${GAP / 2}px))`,
    width: columns === 1 ? "100%" : `calc(50% - ${GAP / 2}px)`,
    transition: placed ? "top 200ms ease, left 200ms ease" : "none",
  });

  // Each card: its icon, its header links, and what's in it.
  const spec = (c: CardSpec): { icon: React.ReactNode; more?: () => void; action?: { label: string; onClick: () => void }; body: React.ReactNode } => {
    switch (c.type) {
      case "upcoming":
        return {
          icon: <ClipboardList className="size-4" />, more: counts.assignments ? () => onTab("assignments") : undefined,
          action: markRead(overview.new.assignments, ["assignment"]),
          body: upcoming.length === 0 ? <Empty>{t("接下来三周没有要交的作业")}</Empty>
            : upcoming.map((a) => <AssignmentRow key={a.id} a={a} onClick={() => onOpen("assignment", a.id)} />),
        };
      case "announcements":
        return {
          icon: <Megaphone className="size-4" />, more: counts.announcements ? () => onTab("announcements") : undefined,
          action: markRead(overview.new.announcements, ["announcement"]),
          body: announcements.length === 0 ? <Empty>{t("还没有公告")}</Empty> : announcements.map((a) => (
            <Row key={a.id} onClick={() => onOpen("announcement", a.id)}>
              <div className="flex items-center gap-2">
                {a.new && <NewDot label={t("新公告")} />}
                <span className={`truncate ${a.new ? "font-medium" : ""}`}>{a.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(a.date, false)}</span>
              </div>
              {a.preview && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{a.preview}</p>}
            </Row>
          )),
        };
      case "modules":
        return {
          icon: <ListChecks className="size-4" />, more: () => onTab("modules"),
          body: current_modules.map((m) => (
            <div key={m.id}>
              <h3 className="truncate px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted">{m.name}</h3>
              {moduleItems(m)}
            </div>
          )),
        };
      case "files":
        return {
          icon: <FileText className="size-4" />, more: () => onTab("files"), action: markRead(overview.new.files, ["file"]),
          body: new_files.length === 0 ? <Empty>{t("还没有文件")}</Empty> : new_files.map((f) => (
            <FileRow key={f.file_id} name={f.name} date={f.date} isNew={f.new} updated={f.updated}
              onOpen={() => void api.openPath(f.path).then(onSeen)} onShow={() => onShowFile(f.path)} />
          )),
        };
      case "grades":
        return {
          icon: <Award className="size-4" />, more: () => onTab("grades"),
          body: (
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
        };
      case "links":
        return {
          icon: <ExternalLink className="size-4" />,
          body: (
            <div className="flex flex-wrap">
              {linkRows.filter((r) => !layout.hidden_links.includes(r.key)).map((r) => (
                <div key={r.key} onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), onMenu(linkMenu(r), e.clientX, e.clientY))}>
                  <Row onClick={r.open}>
                    <span className="flex items-center gap-2">
                      {r.icon}
                      {r.label}
                      {pending === r.key && <span className="text-xs text-muted">{t("正在打开…")}</span>}
                    </span>
                  </Row>
                </div>
              ))}
              <Row onClick={() => setAddingLink(true)}>
                <span className="flex items-center gap-2 text-muted"><Plus className="size-4" />{t("添加链接")}</span>
              </Row>
            </div>
          ),
        };
      case "folder":
        return { icon: <Folder className="size-4" />, more: () => onShowFolder(c.path ?? ""), body: <FolderCard path={c.path ?? ""} onSeen={onSeen} onShowFolder={onShowFolder} /> };
      case "file":
        return { icon: <FileText className="size-4" />, more: () => onShowFile(c.path ?? ""), body: <FileCard path={c.path ?? ""} onSeen={onSeen} /> };
      case "note":
        return { icon: <NotebookPen className="size-4" />, body: <NoteCard course={course} id={c.id ?? ""} /> };
      case "page":
        return { icon: <BookOpen className="size-4" />, more: () => onOpen("page", c.page ?? ""), body: <DocCard course={course} kind="page" id={c.page ?? ""} onNavigate={onNavigate} /> };
      case "syllabus":
        return { icon: <ScrollText className="size-4" />, more: () => onTab("syllabus"), body: <DocCard course={course} kind="syllabus" id={String(course.id)} onNavigate={onNavigate} /> };
      case "module":
        return { icon: <ListChecks className="size-4" />, more: () => onTab("modules"), body: <ModuleCard course={course} id={c.module ?? 0} render={moduleItems} /> };
      case "search":
        return { icon: <SearchIcon className="size-4" />, body: <SearchCard course={course} query={c.query ?? ""} content={!!c.content} onOpen={onOpenHit} /> };
      default:
        return { icon: null, body: null };
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pt-3 pb-6">
        <div className="mb-2 flex items-center justify-end gap-2">
          {layout.own_cards && <span className="text-xs text-muted">{t("这门课单独排过")}</span>}
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(customize(), r.right - 240, r.bottom + 4);
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-chip hover:text-fg"
          >
            <SlidersHorizontal className="size-3.5" />
            {t("自定义概览")}
          </button>
        </div>
        {shown.length === 0 && <p className="py-10 text-center text-sm text-muted">{t("所有卡片都隐藏了。点右上角的“自定义概览”选几张。")}</p>}
        <div ref={setGrid} className="relative" style={{ height: Math.max(0, Math.max(...tops) - GAP) }}>
          {shown.map((c, i) => {
            const s = spec(c);
            return (
              <Card
                key={keyOf(c)}
                cardKey={keyOf(c)}
                style={spot(i)}
                flash={fresh === keyOf(c)}
                cardRef={drag.ref(i)}
                grab={drag.handle(i)}
                mark={drag.mark(i)}
                title={titleOf(c)}
                icon={s.icon}
                more={s.more}
                action={s.action}
                onMenu={(x, y) => onMenu(cardMenu(c), x, y)}
              >
                {s.body}
              </Card>
            );
          })}
        </div>
      </div>

      {adding && (
        <AddCardDialog
          course={course}
          has={cards}
          onClose={() => setAdding(false)}
          onAdd={(card) => {
            setAdding(false);
            setFresh(keyOf(card));
            onLayout({ cards: [...cards, card] });
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          current={titleOf(renaming)}
          title={t("重命名卡片")}
          hint={t("只改这张卡片的标题。")}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => {
            onLayout({ cards: cards.map((c) => (keyOf(c) === keyOf(renaming) ? { ...c, title: name } : c)) });
            setRenaming(null);
          }}
        />
      )}
      {addingLink && (
        <LinkDialog onClose={() => setAddingLink(false)} onAdd={(link) => (setAddingLink(false), onLayout({ links: [...layout.links, link] }))} />
      )}
    </div>
  );
}

function Card({ cardKey, style, flash, title, icon, more, action, cardRef, grab, mark, onMenu, children }: {
  cardKey: string;
  style: React.CSSProperties;
  flash: boolean; // just added: outlined for a moment
  title: string;
  icon: React.ReactNode;
  more?: () => void;
  action?: { label: string; onClick: () => void };
  cardRef: (el: HTMLElement | null) => void;
  grab: { onPointerDown: (e: React.PointerEvent) => void };
  mark: Mark;
  onMenu: (x: number, y: number) => void;
  children: React.ReactNode;
}) {
  return (
    <section ref={cardRef} data-card={cardKey} style={style} className="rounded-xl border border-line bg-panel">
      <DropMark at={mark} />
      {flash && <span aria-hidden className="pointer-events-none absolute -inset-px z-10 animate-[fade-out_2s_ease-in_forwards] rounded-[inherit] ring-2 ring-accent" />}
      <header
        {...grab}
        onContextMenu={(e) => (e.preventDefault(), onMenu(e.clientX, e.clientY))}
        title={t("拖动标题可以移动卡片，右键可以隐藏")}
        className="flex cursor-grab items-center gap-2 px-4 pt-3 pb-1.5 text-sm font-medium active:cursor-grabbing"
      >
        <span className="text-muted">{icon}</span>
        <span className="truncate">{title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-3 text-xs font-normal">
          {action && <button onClick={action.onClick} className="text-muted hover:text-fg">{action.label}</button>}
          {more && <button onClick={more} className="text-muted hover:text-fg">{t("全部 ›")}</button>}
        </span>
      </header>
      <div className="px-2 pb-2">{children}</div>
    </section>
  );
}

function FileRow({ name, date, isNew, updated, onOpen, onShow }: {
  name: string;
  date: string | null;
  isNew?: boolean;
  updated?: boolean;
  onOpen: () => void;
  onShow: () => void;
}) {
  return (
    <Row onClick={onOpen}>
      <div className="flex items-center gap-2">
        <FileIcon name={name} />
        <span className={`truncate ${isNew ? "font-medium" : ""}`}>{name}</span>
        {isNew && <NewDot label={updated ? t("有新版本") : t("新文件")} />}
        {updated && <span className="shrink-0 rounded bg-info-soft px-1.5 text-[11px] text-info">{t("已更新")}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(date, false)}</span>
        <button
          title={t("在文件夹中显示")}
          aria-label={t("在文件夹中显示")}
          onClick={(e) => (e.stopPropagation(), onShow())}
          className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
        >
          <FolderOpen className="size-3.5" />
        </button>
      </div>
    </Row>
  );
}

// -- cards you add ------------------------------------------------------------------------------

/** What's in a folder: its files (newest first) and folders. */
function FolderCard({ path, onSeen, onShowFolder }: { path: string; onSeen: () => void; onShowFolder: (p: string) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => void api.tree(path).then(setEntries, () => setError(true)), [path]);
  if (error) return <Empty>{t("找不到这个文件夹了")}</Empty>;
  if (!entries) return <Empty>{t("正在加载…")}</Empty>;
  const live = entries.filter((e) => !e.deleted);
  if (!live.length) return <Empty>{t("这个文件夹是空的")}</Empty>;
  const sorted = [...live].sort((a, b) => (a.type === b.type ? (b.mtime ?? 0) - (a.mtime ?? 0) : a.type === "dir" ? 1 : -1));
  return (
    <>
      {sorted.slice(0, 12).map((e) => (
        <Row key={e.path} onClick={() => (e.type === "dir" ? onShowFolder(e.path) : void api.openPath(e.path).then(onSeen))}>
          <div className="flex items-center gap-2">
            <FileIcon name={e.name} dir={e.type === "dir"} />
            <span className={`truncate ${e.new ? "font-medium" : ""}`}>{e.name}</span>
            {(e.new || e.new_inside > 0) && <NewDot />}
            {e.mtime && <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(new Date(e.mtime * 1000).toISOString(), false)}</span>}
          </div>
        </Row>
      ))}
      {sorted.length > 12 && (
        <button onClick={() => onShowFolder(path)} className="px-2 py-1 text-xs text-muted hover:text-fg">{t("还有 {n} 项 ›", { n: sorted.length - 12 })}</button>
      )}
    </>
  );
}

/** One file, with a preview: the schedule, the syllabus PDF, a formula sheet. */
function FileCard({ path, onSeen }: { path: string; onSeen: () => void }) {
  const name = path.split("/").pop() ?? path;
  return (
    <button onClick={() => void api.openPath(path).then(onSeen, () => {})} className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-chip">
      <Thumb path={path} name={name} mtime={null} size={56} iconClass="size-10" />
      <span className="min-w-0">
        <span className="block truncate text-sm">{name}</span>
        <span className="text-xs text-muted">{t("点一下打开")}</span>
      </span>
    </button>
  );
}

/** A note for the course: typed here, saved as you go (in the sync folder, .canvas/notes). */
function NoteCard({ course, id }: { course: Course; id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"saved" | "saving" | "failed">("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef("");
  useEffect(() => void api.note(course.id, id).then((n) => setText(n.text), () => setText("")), [course.id, id]);
  // Saves what's pending when the card goes away (another tab, another course).
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void api.saveNote(course.id, id, latest.current);
    }
  }, [course.id, id]);
  const change = (v: string) => {
    setText(v);
    latest.current = v;
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      api.saveNote(course.id, id, v).then(() => setState("saved"), () => setState("failed"));
    }, 500);
  };
  if (text === null) return <Empty>{t("正在加载…")}</Empty>;
  return (
    <div className="px-2 pb-1" data-no-drag>
      <textarea
        value={text}
        onChange={(e) => change(e.target.value)}
        placeholder={t("写点什么：考试范围、办公时间、要问老师的问题…")}
        rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
        className="selectable w-full resize-y rounded-md border border-transparent bg-chip/50 px-2.5 py-2 text-sm leading-relaxed outline-none focus:border-line"
      />
      <p className="text-right text-[11px] text-muted">
        {state === "saving" ? t("正在保存…") : state === "failed" ? t("没保存上，稍后再试") : t("已保存")}
      </p>
    </div>
  );
}

/** A page (or the syllabus), right on the overview: where some instructors keep the schedule. */
function DocCard({ course, kind, id, onNavigate }: { course: Course; kind: DocKind; id: string; onNavigate: (to: CourseLink) => void }) {
  const [item, setItem] = useState<Item | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => void api.item(course.id, kind, id).then(setItem, () => setMissing(true)), [course.id, kind, id]);
  if (missing) return <Empty>{t("找不到这个页面了（可能被删了，或者还没同步）")}</Empty>;
  if (!item) return <Empty>{t("正在加载…")}</Empty>;
  return (
    <div className="max-h-96 overflow-y-auto px-2 pb-1" data-no-drag>
      {item.html.trim() ? <RichText html={item.html} courseId={course.id} files={item.files} onNavigate={onNavigate} /> : <Empty>{t("没有正文。")}</Empty>}
    </div>
  );
}

/** One module, always: "Exam review", "Course resources". */
function ModuleCard({ course, id, render }: { course: Course; id: number; render: (m: Module, limit?: number) => React.ReactNode }) {
  const [module, setModule] = useState<Module | null | undefined>(undefined);
  useEffect(() => void api.modules(course.id).then((ms) => setModule(ms.find((m) => m.id === id) ?? null), () => setModule(null)), [course.id, id]);
  if (module === undefined) return <Empty>{t("正在加载…")}</Empty>;
  if (module === null) return <Empty>{t("找不到这个模块了")}</Empty>;
  return <>{render(module, 12)}</>;
}

/** A saved search in the course: everything with "mt" in its name, say. */
function SearchCard({ course, query, content, onOpen }: { course: Course; query: string; content: boolean; onOpen: (h: Hit) => void }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => void api.search(query, { courses: [course.id], namesOnly: !content, limit: 12 }).then(setHits, () => setHits([])), [course.id, query, content]);
  if (!hits) return <Empty>{t("正在加载…")}</Empty>;
  if (!hits.length) return <Empty>{t("没有结果")}</Empty>;
  return (
    <>
      {hits.map((h) => (
        <Row key={`${h.kind}:${h.path ?? h.doc_id ?? h.title}`} onClick={() => onOpen(h)}>
          <div className="flex items-center gap-2">
            {h.kind === "file" ? <FileIcon name={h.title} /> : <BookOpen className="size-4 shrink-0 text-muted" />}
            <span className="truncate">{h.title}</span>
            {h.date && <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(h.date, false)}</span>}
          </div>
        </Row>
      ))}
    </>
  );
}

function LinkDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (link: { title: string; url: string }) => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const full = url.trim() && !/^https?:\/\//.test(url.trim()) ? `https://${url.trim()}` : url.trim();
  const ok = /^https?:\/\/[^\s/]+\.[^\s]+/.test(full);
  const add = () => ok && onAdd({ title: title.trim() || full.replace(/^https?:\/\//, ""), url: full });
  const input = "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent";
  return (
    <Dialog
      title={t("添加链接")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button primary disabled={!ok} onClick={add}>{t("添加")}</Button>
        </>
      }
    >
      <div className="space-y-3 pb-2" onKeyDown={(e) => e.key === "Enter" && add()}>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("网址")}</span>
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoCorrect="off" autoCapitalize="off" spellCheck={false} className={input} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("名称（可以不填）")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("例如：课程网站")} className={input} />
        </label>
      </div>
    </Dialog>
  );
}
