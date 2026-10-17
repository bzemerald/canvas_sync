// A course's overview: cards, arranged for the course. Its own: what's due, what was said, this
// week's modules, new files, grades, its tools and links (工具与链接), its syllabus. And anything
// of the course you put there: a folder, a file, a note, a page, a module, a search... wherever
// the instructor keeps what matters. Drag a card by its title to move it (or onto 置顶, or the
// tabs); drag something of the course onto the overview and it's a card where you let go (a tool
// or a link goes into 工具与链接). Right-click a title to rename the card, hide it or take it
// away; 自定义概览 has the rest.
import { FolderOpen, Plus, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type { Course, DocKind, Entry as FileEntry, Hit, Item, Module, Overview } from "../lib/api";
import { useDropZone } from "../lib/dropZones";
import { shortDate } from "../lib/dates";
import { t } from "../lib/i18n";
import { DropMark, moved, useReorder, type Mark } from "../lib/reorder";
import {
  type Shown, type Thing, type ThingOf, changed, isView, ofCourse, ownIn, putAt, refill, slotIndex, thingKey, thingOfHit, view,
  without,
} from "../lib/things";
import { AddCardDialog } from "./AddCardDialog";
import { Button, Dialog } from "./Dialog";
import { AssignmentRow, Empty, ModuleRow, Row, SubmissionBadges, TotalLine, docThing, useItemOpener } from "./CourseView";
import { FileIcon } from "./FileIcon";
import type { MenuItem } from "./Menu";
import { RenameDialog } from "./RenameDialog";
import { RichText } from "./RichText";
import { NewDot } from "./Status";
import { Thumb } from "./Thumb";
import { ThingIcon, ownName, pinItem, sections, thingName, useThing, useThings } from "./Things";

const GAP = 16; // px between cards
type Kinds = ("announcement" | "assignment" | "file")[];

/** Things with a card of their own; the rest (a tool, a link, a course...) go into 工具与链接. */
const hasCard = (e: Thing) =>
  e.type === "view" ? !["overview", "pages", "canvas"].includes(e.view) : !["tool", "link", "course"].includes(e.type);

export function CourseOverview({ course, overview, cards, links, own, onArrange, onReset, onMakeDefault, onSay, onMarkSeen }: {
  course: Course;
  overview: Overview | null;
  cards: Shown[] | null; // the overview's, in order, hidden ones too
  links: Shown[]; // 工具与链接's
  own: boolean; // arranged for the course (else as every course is)
  onArrange: (place: "overview" | "links", entries: Shown[]) => void;
  onReset: () => void; // back to the default arrangement (what was added stays)
  onMakeDefault: () => void; // this arrangement for every course that doesn't have its own
  onSay: (message: string, action?: { label: string; run: () => void }) => void;
  onMarkSeen: (kinds: Kinds) => void;
}) {
  const things = useThings();
  const thing = useThing();
  const { activate, pending } = useItemOpener(course.id);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ place: "overview" | "links"; entry: Shown } | null>(null);
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
  // How many columns fit, and how tall each card is. A grid taken off the page (while the next
  // thing loads) measures 0 across and every card 0 tall: nothing to place cards by.
  const measure = useCallback(() => {
    if (!grid?.isConnected) return;
    setColumns(grid.clientWidth >= 760 ? 2 : 1);
    const next: Record<string, number> = {};
    for (const el of Array.from(grid.children) as HTMLElement[]) if (el.dataset.card) next[el.dataset.card] = el.offsetHeight;
    setHeights((h) => (Object.keys(h).length === Object.keys(next).length && Object.keys(next).every((k) => h[k] === next[k]) ? h : next));
  }, [grid]);
  useEffect(() => {
    if (!grid) return;
    const observer = new ResizeObserver(measure);
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

  const all = cards ?? [];
  const isOwn = (e: Thing) => ownIn("overview", e, course.id);
  const available = (e: Thing) =>
    !isView(e) || !isOwn(e) ? true
      : e.view === "modules" ? !!overview?.current_modules.length
        : e.view === "grades" ? !!overview?.counts.grades
          : e.view === "syllabus" ? !!overview?.counts.syllabus
            : true;
  const shown = all.filter((e) => !e.hidden && available(e));
  const add = (entry: Shown, index = all.length) => {
    setFresh(thingKey(entry));
    onArrange("overview", putAt(all, { ...entry, hidden: false }, index));
  };
  const linkTo = (entry: Shown, index = links.length) => onArrange("links", putAt(links, { ...entry, hidden: false }, index));
  // Dropped on the overview: a card where it was let go (a tool or a link: into 工具与链接).
  const slotAt = (x: number, y: number) => {
    const els = Array.from(grid?.querySelectorAll<HTMLElement>(":scope > [data-card]") ?? []);
    const i = els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (i >= 0) return shown.findIndex((e) => thingKey(e) === els[i].dataset.card);
    return shown.length;
  };
  const zone = useDropZone(
    (entry, slot) => (hasCard(entry) ? add(entry, slotIndex(all, shown, slot)) : linkTo(entry)),
    slotAt,
    (e) => ofCourse(e, course) && !isView(e, "overview"),
  );
  const drag = useReorder(shown.length, (from, to) => onArrange("overview", refill(all, shown, moved(shown, from, to))), "cards", {
    zone: zone.id,
    thing: (i) => shown[i],
  });

  if (!overview || !cards) return <p className="px-6 py-8 text-sm text-muted">{t("正在加载…")}</p>;
  const { upcoming, announcements, new_files, counts, grades, tools, current_modules } = overview;
  const empty = !counts.announcements && !counts.assignments && !counts.pages && !counts.files && !counts.syllabus;
  if (empty && all.every((e) => e.hidden || isOwn(e))) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-sm text-fg-soft">
        <p className="mb-2 text-base text-fg">{t("这门课在 Canvas 上几乎没有内容。")}</p>
        <p className="text-muted">{t("很多课程把材料放在课程网站、Ed 或 Gradescope 上。")}</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-4 text-accent hover:underline">{t("在 Canvas 中打开这门课")}</button>
      </div>
    );
  }

  const titleOf = (e: Shown) => e.title || (isView(e, "tools") && !tools.length ? t("链接") : thingName(e, things.courses, "card"));
  /** Taken away from the overview (or 工具与链接), with 撤销. */
  const takeAway = (place: "overview" | "links", e: Shown, name: string) => {
    const before = place === "overview" ? all : links;
    onArrange(place, without(before, e));
    onSay(t("已移除“{name}”", { name }), { label: t("撤销"), run: () => onArrange(place, before) });
  };
  const customize = (): MenuItem[] => [
    ...all.map((e): MenuItem => isOwn(e)
      ? {
          label: titleOf(e), checked: !e.hidden, hint: !e.hidden && !available(e) ? t("这门课没有") : undefined,
          onSelect: () => onArrange("overview", changed(all, e, { hidden: !e.hidden })),
        }
      : { label: titleOf(e), checked: true, onSelect: () => takeAway("overview", e, titleOf(e)) }),
    "separator",
    { label: t("添加卡片…"), onSelect: () => setAdding(true) },
    "separator",
    { label: t("设为所有课程的默认概览"), onSelect: onMakeDefault },
    { label: t("恢复默认（和其他课程一样）"), disabled: !own, onSelect: onReset },
  ];
  /** Rename, restore its name, hide (its own) or take away (what you put there). */
  const placing = (place: "overview" | "links", e: Shown, name: string): MenuItem[] => {
    const list = place === "overview" ? all : links;
    return [
      { label: t("重命名…"), onSelect: () => setRenaming({ place, entry: e }) },
      ...(e.title ? [{ label: t("恢复原名（{name}）", { name: ownName(e, things.courses, place === "overview" ? "card" : "row") }), onSelect: () => onArrange(place, changed(list, e, { title: "" })) }] : []),
      ownIn(place, e, course.id)
        ? { label: t("隐藏“{name}”", { name }), onSelect: () => onArrange(place, changed(list, e, { hidden: true })) }
        : { label: place === "overview" ? t("删除卡片") : t("删除链接"), danger: true, onSelect: () => takeAway(place, e, name) },
    ];
  };

  // 工具与链接: the course's tools, its syllabus, Canvas; and what you put there. Each can be hidden.
  const linkShown = links.filter((e) => !e.hidden && (!isView(e, "syllabus") || counts.syllabus));
  const hiddenLinks = links.filter((e) => e.hidden);
  const cardMenu = (e: Shown): MenuItem[] => sections(
    isOwn(e) ? [] : things.ways(e),
    placing("overview", e, titleOf(e)),
    [pinItem(things, e)],
    isView(e, "tools")
      ? [
          { label: t("添加链接…"), onSelect: () => setAddingLink(true) },
          ...hiddenLinks.map((x) => ({
            label: t("显示“{name}”", { name: thingName(x, things.courses) }),
            onSelect: () => onArrange("links", changed(links, x, { hidden: false })),
          })),
        ]
      : [],
    customize(),
  );

  const markRead = (n: number, kinds: Kinds) => (n > 0 ? { label: t("标为已读"), onClick: () => onMarkSeen(kinds) } : undefined);
  const more = (name: Parameters<typeof view>[1]) => () => things.open(view(course.id, name));
  const moduleItems = (m: Module, limit = 10) => (
    <>
      <ul>
        {m.items.slice(0, limit).map((it, i) => (
          <ModuleRow key={it.id ?? i} it={{ ...it, indent: 0 }} course={course.id} opening={!!it.tool && pending === `item:${it.tool.module_item_id}`} onClick={() => activate(it)} />
        ))}
      </ul>
      {m.items.length > limit && (
        <button onClick={() => things.open({ type: "module", course: course.id, module: m.id })} className="px-2 py-1 text-xs text-muted hover:text-fg">{t("还有 {n} 项 ›", { n: m.items.length - limit })}</button>
      )}
    </>
  );

  // Where each card goes: down the shorter column.
  const tops = Array.from({ length: columns }, () => 0);
  const spots = shown.map((c) => {
    const col = tops.indexOf(Math.min(...tops));
    const top = tops[col];
    tops[col] += (heights[thingKey(c)] ?? 0) + GAP;
    return { col, top };
  });
  const spot = (i: number): React.CSSProperties => ({
    position: "absolute",
    top: spots[i].top,
    left: columns === 1 ? 0 : `calc(${spots[i].col} * (50% + ${GAP / 2}px))`,
    width: columns === 1 ? "100%" : `calc(50% - ${GAP / 2}px)`,
    transition: placed ? "top 200ms ease, left 200ms ease" : "none",
  });

  // Each card: its header links, and what's in it.
  const spec = (e: Shown): { more?: () => void; action?: { label: string; onClick: () => void }; body: React.ReactNode } => {
    if (e.type === "view" && isOwn(e)) {
      switch (e.view) {
        case "assignments":
          return {
            more: counts.assignments ? more("assignments") : undefined, action: markRead(overview.new.assignments, ["assignment"]),
            body: upcoming.length === 0 ? <Empty>{t("接下来三周没有要交的作业")}</Empty>
              : upcoming.map((a) => <AssignmentRow key={a.id} a={a} course={course.id} onClick={() => things.open(docThing(course.id, a))} />),
          };
        case "announcements":
          return {
            more: counts.announcements ? more("announcements") : undefined, action: markRead(overview.new.announcements, ["announcement"]),
            body: announcements.length === 0 ? <Empty>{t("还没有公告")}</Empty> : announcements.map((a) => (
              <Row key={a.id} onClick={() => things.open(docThing(course.id, a))} thing={docThing(course.id, a)}>
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
            more: more("modules"),
            body: current_modules.map((m) => (
              <div key={m.id}>
                <h3 className="truncate px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted" {...thing({ type: "module", course: course.id, module: m.id, name: m.name })}>{m.name}</h3>
                {moduleItems(m)}
              </div>
            )),
          };
        case "files":
          return {
            more: more("files"), action: markRead(overview.new.files, ["file"]),
            body: new_files.length === 0 ? <Empty>{t("还没有文件")}</Empty> : new_files.map((f) => (
              <FileRow key={f.file_id} path={f.path} name={f.name} date={f.date} isNew={f.new} updated={f.updated} />
            )),
          };
        case "grades":
          return {
            more: more("grades"),
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
                  <Row key={a.id} onClick={() => things.open(docThing(course.id, a))} thing={docThing(course.id, a)}>
                    <div className="flex items-center gap-2">
                      <span className="truncate">{a.title}</span>
                      <span className="ml-auto flex shrink-0 gap-1"><SubmissionBadges a={a} /></span>
                    </div>
                  </Row>
                ))}
              </>
            ),
          };
        case "tools":
          return {
            body: <LinksList course={course} links={links} shown={linkShown} menu={(x) => sections(things.ways(x), placing("links", x, thingName(x, things.courses)), [pinItem(things, x)])}
              onArrange={(next) => onArrange("links", next)} onTakeAway={(x) => takeAway("links", x, thingName(x, things.courses))} onAdd={() => setAddingLink(true)} />,
          };
        case "syllabus":
          return { more: more("syllabus"), body: <DocCard course={course} kind="syllabus" id={String(course.id)} /> };
      }
    }
    switch (e.type) {
      case "folder":
        return { more: () => things.open(e), body: <FolderCard path={e.path} /> };
      case "file":
        return { more: () => things.showInFolder(e.path), body: <FileCard file={e} /> };
      case "note":
        return { body: <NoteEditor course={course.id} id={e.id} /> };
      case "doc":
        return { more: () => things.open(e), body: <DocCard course={course} kind={e.kind} id={e.id} /> };
      case "module":
        return { more: () => things.open(e), body: <ModuleCard course={course.id} id={e.module} render={moduleItems} /> };
      case "search":
        return { more: () => things.open(e), body: <SearchCard search={e} /> };
      default: // (a view of no card of its own, a tool, a link...: put here by hand)
        return { body: <Row onClick={() => things.open(e)} thing={e}><span className="text-muted">{t("打开 ›")}</span></Row> };
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pt-3 pb-6">
        <div className="mb-2 flex items-center justify-end gap-2">
          {own && <span className="text-xs text-muted">{t("这门课单独排过")}</span>}
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              things.menu(customize(), r.right - 240, r.bottom + 4);
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-chip hover:text-fg"
          >
            <SlidersHorizontal className="size-3.5" />
            {t("自定义概览")}
          </button>
        </div>
        {shown.length === 0 && <p className="py-10 text-center text-sm text-muted">{t("所有卡片都隐藏了。点右上角的“自定义概览”选几张。")}</p>}
        <div
          ref={(el) => {
            setGrid(el);
            zone.ref(el);
          }}
          className={`relative rounded-xl ${zone.state === "over" && zone.slot >= shown.length ? "ring-2 ring-accent/60" : zone.state !== "idle" ? "outline-1 outline-offset-4 outline-dashed outline-accent/60" : ""}`}
          style={{ height: Math.max(48, Math.max(...tops) - GAP) }}
        >
          {shown.map((e, i) => {
            const s = spec(e);
            return (
              <Card
                key={thingKey(e)}
                cardKey={thingKey(e)}
                style={spot(i)}
                flash={fresh === thingKey(e)}
                cardRef={drag.ref(i)}
                grab={drag.handle(i)}
                mark={zone.state === "over" && zone.slot === i ? "onto" : drag.mark(i)}
                title={titleOf(e)}
                icon={<ThingIcon thing={e} courses={things.courses} />}
                more={s.more}
                action={s.action}
                onMenu={(x, y) => things.menu(cardMenu(e), x, y)}
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
          shown={shown}
          onClose={() => setAdding(false)}
          onAdd={(entry) => {
            setAdding(false);
            add(entry);
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          current={renaming.place === "overview" ? titleOf(renaming.entry) : thingName(renaming.entry, things.courses)}
          title={renaming.place === "overview" ? t("重命名卡片") : t("重命名链接")}
          hint={renaming.place === "overview" ? t("只改这张卡片的标题。") : t("只改在这里显示的名字。")}
          onClose={() => setRenaming(null)}
          onSubmit={(title) => {
            onArrange(renaming.place, changed(renaming.place === "overview" ? all : links, renaming.entry, { title }));
            setRenaming(null);
          }}
        />
      )}
      {addingLink && (
        <LinkDialog onClose={() => setAddingLink(false)} onAdd={(link) => (setAddingLink(false), linkTo({ type: "link", url: link.url, title: link.title }))} />
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
    <section ref={cardRef} data-card={cardKey} data-home style={style} className="rounded-xl border border-line bg-panel">
      <DropMark at={mark} />
      {flash && <span aria-hidden className="pointer-events-none absolute -inset-px z-10 animate-[fade-out_2s_ease-in_forwards] rounded-[inherit] ring-2 ring-accent" />}
      <header
        {...grab}
        onContextMenu={(e) => (e.preventDefault(), onMenu(e.clientX, e.clientY))}
        title={t("拖动标题可以移动卡片，右键可以重命名或隐藏")}
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

/** 工具与链接's rows: the course's tools, its syllabus, Canvas, and what you put there. Drag them
 * into your order, or anything in among them; drag one you put there off to take it away. */
function LinksList({ course, links, shown, menu, onArrange, onTakeAway, onAdd }: {
  course: Course;
  links: Shown[]; // all of them, hidden ones too
  shown: Shown[];
  menu: (e: Shown) => MenuItem[];
  onArrange: (next: Shown[]) => void;
  onTakeAway: (e: Shown) => void;
  onAdd: () => void;
}) {
  const things = useThings();
  const box = useRef<HTMLDivElement>(null);
  const own = (e: Thing) => ownIn("links", e, course.id);
  const slotAt = (x: number, y: number) => {
    const rows = Array.from(box.current?.querySelectorAll<HTMLElement>(":scope > [data-link]") ?? []);
    const i = rows.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return y <= r.bottom && (y < r.top || x < r.left + r.width / 2);
    });
    return i < 0 ? shown.length : i;
  };
  const zone = useDropZone((entry, slot) => onArrange(putAt(links, { ...entry, hidden: false }, slotIndex(links, shown, slot))), slotAt,
    (e) => ofCourse(e, course) && !isView(e, "overview") && !isView(e, "tools"));
  const drag = useReorder(shown.length, (from, to) => onArrange(refill(links, shown, moved(shown, from, to))), "cards", {
    zone: zone.id,
    thing: (i) => shown[i],
    remove: (i) => (own(shown[i]) ? null : () => onTakeAway(shown[i])),
  });
  return (
    <div ref={(el) => {
      box.current = el;
      zone.ref(el);
    }} className={`relative flex flex-wrap rounded-md ${zone.state === "over" ? "bg-accent/10" : ""}`}>
      {shown.map((e, i) => (
        <div key={thingKey(e)} data-link className="relative rounded-md" {...drag.item(i)}
          onContextMenu={(ev) => (ev.preventDefault(), ev.stopPropagation(), things.menu(menu(e), ev.clientX, ev.clientY))}>
          <DropMark at={zone.state === "over" && zone.slot === i ? "onto" : drag.mark(i)} />
          <Row onClick={() => things.open(e)}>
            <span className="flex items-center gap-2">
              <span className="text-muted"><ThingIcon thing={e} courses={things.courses} /></span>
              {thingName(e, things.courses)}
              {things.opening === thingKey(e) && <span className="text-xs text-muted">{t("正在打开…")}</span>}
            </span>
          </Row>
        </div>
      ))}
      <Row onClick={onAdd}>
        <span className="flex items-center gap-2 text-muted"><Plus className="size-4" />{t("添加链接")}</span>
      </Row>
    </div>
  );
}

/** 工具与链接 as a tab of its own. */
export function LinksPage({ course, links, syllabus, onArrange, onSay }: {
  course: Course;
  links: Shown[];
  syllabus: boolean; // the course has one
  onArrange: (next: Shown[]) => void;
  onSay: (message: string, action?: { label: string; run: () => void }) => void;
}) {
  const things = useThings();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Shown | null>(null);
  const shown = links.filter((e) => !e.hidden && (!isView(e, "syllabus") || syllabus));
  const takeAway = (e: Shown) => {
    onArrange(without(links, e));
    onSay(t("已移除“{name}”", { name: thingName(e, things.courses) }), { label: t("撤销"), run: () => onArrange(links) });
  };
  const menu = (e: Shown): MenuItem[] => sections(things.ways(e), [
    { label: t("重命名…"), onSelect: () => setRenaming(e) },
    ...(e.title ? [{ label: t("恢复原名（{name}）", { name: ownName(e, things.courses) }), onSelect: () => onArrange(changed(links, e, { title: "" })) }] : []),
    ownIn("links", e, course.id)
      ? { label: t("隐藏“{name}”", { name: thingName(e, things.courses) }), onSelect: () => onArrange(changed(links, e, { hidden: true })) }
      : { label: t("删除链接"), danger: true, onSelect: () => takeAway(e) },
  ], [pinItem(things, e)], links.filter((x) => x.hidden).map((x) => ({
    label: t("显示“{name}”", { name: thingName(x, things.courses) }), onSelect: () => onArrange(changed(links, x, { hidden: false })),
  })));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <LinksList course={course} links={links} shown={shown} menu={menu} onArrange={onArrange} onTakeAway={takeAway} onAdd={() => setAdding(true)} />
      </div>
      {adding && <LinkDialog onClose={() => setAdding(false)} onAdd={(link) => (setAdding(false), onArrange(putAt(links, { type: "link", url: link.url, title: link.title }, links.length)))} />}
      {renaming && (
        <RenameDialog current={thingName(renaming, things.courses)} title={t("重命名链接")} hint={t("只改在这里显示的名字。")}
          onClose={() => setRenaming(null)} onSubmit={(title) => (onArrange(changed(links, renaming, { title })), setRenaming(null))} />
      )}
    </div>
  );
}

function FileRow({ path, name, date, isNew, updated }: { path: string; name: string; date: string | null; isNew?: boolean; updated?: boolean }) {
  const things = useThings();
  const file = { type: "file" as const, path };
  return (
    <Row onClick={() => things.open(file)} thing={file}>
      <div className="flex items-center gap-2">
        <FileIcon name={name} />
        <span className={`truncate ${isNew ? "font-medium" : ""}`}>{name}</span>
        {isNew && <NewDot label={updated ? t("有新版本") : t("新文件")} />}
        {updated && <span className="shrink-0 rounded bg-info-soft px-1.5 text-[11px] text-info">{t("已更新")}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(date, false)}</span>
        <button
          title={t("在文件夹中显示")}
          aria-label={t("在文件夹中显示")}
          onClick={(e) => (e.stopPropagation(), things.showInFolder(path))}
          className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
        >
          <FolderOpen className="size-3.5" />
        </button>
      </div>
    </Row>
  );
}

// -- cards of things you put on the overview -------------------------------------------------------

/** What's in a folder: its files (newest first) and folders. */
function FolderCard({ path }: { path: string }) {
  const things = useThings();
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => void api.tree(path).then(setEntries, () => setError(true)), [path]);
  if (error) return <Empty>{t("找不到这个文件夹了")}</Empty>;
  if (!entries) return <Empty>{t("正在加载…")}</Empty>;
  const live = entries.filter((e) => !e.deleted);
  if (!live.length) return <Empty>{t("这个文件夹是空的")}</Empty>;
  const sorted = [...live].sort((a, b) => (a.type === b.type ? (b.mtime ?? 0) - (a.mtime ?? 0) : a.type === "dir" ? 1 : -1));
  return (
    <>
      {sorted.slice(0, 12).map((e) => {
        const it: Thing = e.type === "dir" ? { type: "folder", path: e.path } : { type: "file", path: e.path };
        return (
          <Row key={e.path} onClick={() => things.open(it)} thing={it}>
            <div className="flex items-center gap-2">
              <FileIcon name={e.name} dir={e.type === "dir"} />
              <span className={`truncate ${e.new ? "font-medium" : ""}`}>{e.name}</span>
              {(e.new || e.new_inside > 0) && <NewDot />}
              {e.mtime && <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(new Date(e.mtime * 1000).toISOString(), false)}</span>}
            </div>
          </Row>
        );
      })}
      {sorted.length > 12 && (
        <button onClick={() => things.open({ type: "folder", path })} className="px-2 py-1 text-xs text-muted hover:text-fg">{t("还有 {n} 项 ›", { n: sorted.length - 12 })}</button>
      )}
    </>
  );
}

/** One file, with a preview: the schedule, the syllabus PDF, a formula sheet. */
function FileCard({ file }: { file: ThingOf<"file"> }) {
  const things = useThings();
  const props = useThing();
  const name = file.path.split("/").pop() ?? file.path;
  return (
    <button onClick={() => things.open(file)} {...props(file)} className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-chip">
      <Thumb path={file.path} name={name} mtime={null} size={56} iconClass="size-10" />
      <span className="min-w-0">
        <span className="block truncate text-sm">{name}</span>
        <span className="text-xs text-muted">{t("点一下打开")}</span>
      </span>
    </button>
  );
}

/** A note: typed here, saved as you go (in the sync folder, .canvas/notes). On a card, or as a
 * tab of its own (`page`). */
export function NoteEditor({ course, id, page = false }: { course: number; id: string; page?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"saved" | "saving" | "failed">("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef("");
  useEffect(() => void api.note(course, id).then((n) => setText(n.text), () => setText("")), [course, id]);
  // Saves what's pending when it goes away (another tab, another course).
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void api.saveNote(course, id, latest.current);
    }
  }, [course, id]);
  const change = (v: string) => {
    setText(v);
    latest.current = v;
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      api.saveNote(course, id, v).then(() => setState("saved"), () => setState("failed"));
    }, 500);
  };
  if (text === null) return <Empty>{t("正在加载…")}</Empty>;
  return (
    <div className={page ? "flex min-h-0 flex-1 flex-col px-6 py-4" : "px-2 pb-1"} data-no-drag>
      <textarea
        value={text}
        onChange={(e) => change(e.target.value)}
        placeholder={t("写点什么：考试范围、办公时间、要问老师的问题…")}
        rows={page ? undefined : Math.min(14, Math.max(4, text.split("\n").length + 1))}
        className={`selectable w-full rounded-md border border-transparent bg-chip/50 px-2.5 py-2 text-sm leading-relaxed outline-none focus:border-line ${page ? "mx-auto max-w-3xl flex-1 resize-none" : "resize-y"}`}
      />
      <p className={`text-right text-[11px] text-muted ${page ? "mx-auto w-full max-w-3xl pt-1" : ""}`}>
        {state === "saving" ? t("正在保存…") : state === "failed" ? t("没保存上，稍后再试") : t("已保存")}
      </p>
    </div>
  );
}

/** A page (or an announcement, an assignment, the syllabus), right on the overview: where some
 * instructors keep the schedule. */
function DocCard({ course, kind, id }: { course: Course; kind: DocKind; id: string }) {
  const [item, setItem] = useState<Item | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => void api.item(course.id, kind, id).then(setItem, () => setMissing(true)), [course.id, kind, id]);
  if (missing) return <Empty>{t("找不到这个页面了（可能被删了，或者还没同步）")}</Empty>;
  if (!item) return <Empty>{t("正在加载…")}</Empty>;
  return (
    <div className="max-h-96 overflow-y-auto px-2 pb-1" data-no-drag>
      {item.html.trim() ? <RichText html={item.html} files={item.files} /> : <Empty>{t("没有正文。")}</Empty>}
    </div>
  );
}

/** One module, always: "Exam review", "Course resources". */
function ModuleCard({ course, id, render }: { course: number; id: number; render: (m: Module, limit?: number) => React.ReactNode }) {
  const [module, setModule] = useState<Module | null | undefined>(undefined);
  useEffect(() => void api.modules(course).then((ms) => setModule(ms.find((m) => m.id === id) ?? null), () => setModule(null)), [course, id]);
  if (module === undefined) return <Empty>{t("正在加载…")}</Empty>;
  if (module === null) return <Empty>{t("找不到这个模块了")}</Empty>;
  return <>{render(module, 12)}</>;
}

/** A saved search: everything with "mt" in its name, say. */
function SearchCard({ search }: { search: ThingOf<"search"> }) {
  const things = useThings();
  const [hits, setHits] = useState<Hit[] | null>(null);
  const { query, courses, kinds, content } = search;
  useEffect(
    () => void api.search(query, { courses, kinds, namesOnly: !content, limit: 12 }).then(setHits, () => setHits([])),
    [query, courses.join(","), kinds.join(","), content], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (!hits) return <Empty>{t("正在加载…")}</Empty>;
  if (!hits.length) return <Empty>{t("没有结果")}</Empty>;
  return (
    <>
      {hits.map((h) => {
        const it = thingOfHit(h);
        return (
          <Row key={`${h.kind}:${h.path ?? h.doc_id ?? h.title}`} onClick={() => (it ? things.open(it) : void api.openHit(h))} thing={it && { ...it, name: h.title }}>
            <div className="flex items-center gap-2">
              {h.kind === "file" ? <FileIcon name={h.title} /> : it ? <ThingIcon thing={it} /> : null}
              <span className="truncate">{h.title}</span>
              {h.date && <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(h.date, false)}</span>}
            </div>
          </Row>
        );
      })}
    </>
  );
}

function LinkDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (link: { title: string; url: string }) => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const full = url.trim() && !/^https?:\/\//.test(url.trim()) ? `https://${url.trim()}` : url.trim();
  const ok = /^https?:\/\/[^\s/]+\.[^\s]+/.test(full);
  const add = () => ok && onAdd({ title: title.trim(), url: full });
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
