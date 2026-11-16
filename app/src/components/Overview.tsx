// A course's overview: cards, arranged for the course. Its own: what's due, what was said, this
// week's modules, new files, grades, its tools and links (工具与链接), its syllabus. And anything
// of the course you put there: a folder, a file, a note, a page, a module, a search... wherever
// the instructor keeps what matters. Drag a card by its title to move it (or onto 置顶, or the
// tabs); drag something of the course onto the overview and it's a card where you let go (a tool
// or a link goes into 工具与链接). Right-click a card to rename it, hide it or take it away;
// right-click between the cards (or 自定义概览) for the overview as a whole.
import { FolderOpen, Pin, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type { Course, DocKind, Hit, Module, NewsView, Overview } from "../lib/api";
import { courseUrl } from "../lib/canvas";
import { shortDate } from "../lib/dates";
import { t, tn } from "../lib/i18n";
import { GLIDE, useFlip } from "../lib/flip";
import { Settling, lineIn, slotInColumn } from "../lib/slot";
import { remember, useLoaded } from "../lib/useLoaded";
import { type Shown, type Thing, type ThingOf, isView, ofCourse, thingKey, thingOfHit, view } from "../lib/things";
import { AddCardDialog } from "./AddCardDialog";
import { Button, Dialog } from "./Dialog";
import { AssignmentRow, EdAnnouncementMark, Empty, ModuleRow, Row, SubmissionBadges, TotalLine, docThing, useItemOpener } from "./CourseView";
import { FileIcon } from "./FileIcon";
import type { MenuItem } from "./Menu";
import { type Place, usePlace, usePlaceDrag } from "./Place";
import { RenameInput } from "./RenameInput";
import { RichText } from "./RichText";
import { Loading, NewDot } from "./Status";
import { Thumb } from "./Thumb";
import { SourceTag, ThingIcon, pinItem, sections, thingName, useThing, useThings } from "./Things";

const GAP = 16; // px between cards

/** Which column each of a course's cards is in, as you put them (on this device, like other view
 * preferences: the order is the course's, in config.toml). */
const columnsPref = (course: number) => `pref:overview-columns:${course}`;
function loadColumns(course: number): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(columnsPref(course)) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function saveColumns(course: number, columns: Record<string, number>) {
  try {
    localStorage.setItem(columnsPref(course), JSON.stringify(columns));
  } catch {
    /* not remembered */
  }
}
const DROP = "drop"; // the slot that opens for something dropped from elsewhere (工具与链接's)
const SETTLE = 120; // ms a new place to go holds before the cards move for it

/** Cards in order, each down the column it's in (`was`: where you put it), so that a card put in
 * or taken out moves only the ones below it in its column; a card new here down the shortest (so
 * the columns come out about even). `put`: cards that go in a given column (what's dragged: where
 * the pointer is). Each one's column and top, by key; how tall it all is. */
function stack(keys: string[], heights: Record<string, number>, columns: number, was: Record<string, number> = {}, put: Record<string, number> = {}) {
  const tops = Array.from({ length: columns }, () => 0);
  const spots: Record<string, { col: number; top: number }> = {};
  for (const k of keys) {
    const want = put[k] ?? was[k];
    const col = want !== undefined && want < columns ? want : tops.indexOf(Math.min(...tops));
    spots[k] = { col, top: tops[col] };
    tops[col] += (heights[k] ?? 0) + GAP;
  }
  return { spots, height: Math.max(0, Math.max(...tops) - GAP) };
}

/** Of boxes, the one (x, y) is in, or nearest; between two it's in (a short card's spot above
 * a tall one's), the one whose middle is nearest. */
function nearest(boxes: { left: number; top: number; width: number; height: number }[], x: number, y: number): number {
  let best = -1;
  let score = [Infinity, Infinity];
  boxes.forEach((b, i) => {
    const dx = Math.max(b.left - x, 0, x - b.left - b.width);
    const dy = Math.max(b.top - y, 0, y - b.top - b.height);
    const s = [dx * dx + dy * dy, Math.abs(y - b.top - b.height / 2) + Math.abs(x - b.left - b.width / 2)];
    if (s[0] < score[0] || (s[0] === score[0] && s[1] < score[1])) [best, score] = [i, s];
  });
  return best;
}
const LOADING = "px-2 py-3 text-sm"; // (as Empty)

/** Things with a card of their own; the rest (a tool, a link, a course...) go into 工具与链接. */
const hasCard = (e: Thing) =>
  e.type === "view" ? !["overview", "pages", "canvas"].includes(e.view) : !["tool", "link", "course"].includes(e.type);

type Say = (message: string, action?: { label: string; run: () => void }) => void;

/** 工具与链接 as a place: the course's tools, its syllabus (if it has one) and Canvas, which can
 * be hidden; and what you put there. */
function useLinks(links: Shown[], syllabus: boolean, onArrange: (next: Shown[]) => void, onSay: Say) {
  const things = useThings();
  return usePlace({
    entries: links, shown: links.filter((e) => !e.hidden && (!isView(e, "syllabus") || syllabus)), onArrange, onSay,
    name: (e) => thingName(e, things.courses), taken: (name) => t("Removed “{name}”", { name }),
  });
}

export function CourseOverview({ course, overview, cards, links, onArrange, onSay, onMarkSeen }: {
  course: Course;
  overview: Overview | null;
  cards: Shown[] | null; // the overview's, in order, hidden ones too
  links: Shown[]; // 工具与链接's
  onArrange: (place: "overview" | "links", entries: Shown[]) => void;
  onSay: Say;
  onMarkSeen: (of: NewsView) => void;
}) {
  const things = useThings();
  const thing = useThing();
  const { activate, pending } = useItemOpener(course.id);
  const [adding, setAdding] = useState(false);
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
  const isOwn = (e: Shown) => !!e.own; // (the overview's own cards: the course's views)
  const available = (e: Shown) =>
    !isView(e) || !isOwn(e) ? true
      : e.view === "modules" ? !!overview?.current_modules.length
        : e.view === "grades" ? !!overview?.counts.grades
          : e.view === "syllabus" ? !!overview?.counts.syllabus
            : e.view === "ed" ? !!overview?.counts.ed
              : true;
  const shown = all.filter((e) => !e.hidden && available(e));
  const titleOf = (e: Shown) => e.title || (isView(e, "tools") && !overview?.tools.length ? t("Links") : thingName(e, things.courses, "card"));
  // The two places here: the cards, and 工具与链接 (one of the cards; a tool or a link goes there).
  const cardPlace = usePlace({
    entries: all, shown, onArrange: (next) => onArrange("overview", next), onSay, name: titleOf, taken: (name) => t("Removed “{name}”", { name }),
  });
  const linkPlace = useLinks(links, !!overview?.counts.syllabus, (next) => onArrange("links", next), onSay);
  /** A card for it (at `slot` among those shown, or last), outlined for a moment. */
  const add = (entry: Shown, slot?: number) => {
    setFresh(thingKey(entry));
    cardPlace.put(entry, slot);
  };
  const keys = shown.map(thingKey);
  // Each card's column, as last drawn (not while dragging), remembered for the course.
  const was = useRef({ course: course.id, cols: loadColumns(course.id) });
  if (was.current.course !== course.id) was.current = { course: course.id, cols: loadColumns(course.id) };
  const dropColumn = useRef(0); // the column what's dragged goes in: the pointer's
  const [, showColumn] = useState(0); // (another column can be the same slot: it's drawn there all the same)
  // A card dragged here: where the pointer says goes on showing once it has held a moment: on the
  // line between two columns, the cards don't jump back and forth. Let go, it lands where it shows.
  const settling = useRef<Settling<{ slot: number; col: number }> | null>(null);
  const reread = useRef(() => {}); // (once it has: the drag, below, reads the slot again)
  settling.current ??= new Settling(SETTLE, ({ col }) => {
    dropColumn.current = col;
    showColumn(col);
    reread.current();
  });
  /** Where in `rest` (the cards without it) something dragged goes, with the pointer at (x, y): in
   * the pointer's column, by the middles of its cards (lib/slot.ts). There it takes just that
   * card's spot: the cards before it, and the other column, stay put. So the answer comes from
   * `rest` as it was, not from what's drawn (the cards making room would change it, and that the
   * cards, and so on). */
  const slotFor = (rest: string[], x: number, y: number) => {
    if (!grid) return { slot: rest.length, col: dropColumn.current };
    const r = grid.getBoundingClientRect();
    const col = columns === 1 || x < r.left + r.width / 2 ? 0 : 1;
    const { spots } = stack(rest, heights, columns, was.current.cols);
    return { slot: slotInColumn(rest.map((k) => ({ ...spots[k], height: heights[k] ?? 0 })), col, y - r.top), col };
  };
  // Dragged in from elsewhere: a line shows where it'd go (a tool or a link: 工具与链接). The cards
  // stay where they are, so it can follow the pointer at once.
  const slotAt = (x: number, y: number) => {
    const { slot, col } = slotFor(keys, x, y);
    dropColumn.current = col;
    showColumn(col);
    return slot;
  };
  const { zone, drag } = usePlaceDrag(cardPlace, "cards", {
    slotAt,
    accepts: (e) => ofCourse(e, course) && !isView(e, "overview"),
    drop: (entry, slot) => {
      if (!hasCard(entry)) return linkPlace.put(entry);
      was.current.cols[thingKey(entry)] = dropColumn.current; // (it stays where it was shown going)
      add(entry, slot);
    },
    moved: (from, to) => {
      was.current.cols[keys[from]] = dropColumn.current; // (maybe just to the other column)
      cardPlace.move(from, to);
    },
    off: null, // (a card is taken away from its menu)
    itemSlotAt: (x, y, from) => {
      const { slot, col } = slotFor(keys.filter((_, i) => i !== from), x, y);
      return settling.current!.see(`${slot}:${col}`, { slot, col }).slot;
    },
  });
  const inserting = zone.state === "over" && !!zone.entry && hasCard(zone.entry);
  reread.current = drag.again;
  const dragging = drag.dragging !== null;
  useEffect(() => {
    if (!dragging) settling.current?.clear();
  }, [dragging]);
  useEffect(() => () => settling.current?.clear(), []);
  useFlip(grid, placed);

  if (!overview || !cards) return <Loading />;
  const { upcoming, announcements, ed, new_files, counts, grades, current_modules } = overview;
  const empty = !counts.announcements && !counts.assignments && !counts.pages && !counts.files && !counts.syllabus && !counts.ed;
  if (empty && all.every((e) => e.hidden || isOwn(e))) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-sm text-fg-soft">
        <p className="mb-2 text-base text-fg">{t("This course has almost nothing on Canvas.")}</p>
        <p className="text-muted">{t("Many courses keep their materials on a course website, Ed or Gradescope instead.")}</p>
        <button onClick={() => void api.openUrl(courseUrl(course.id))} className="mt-4 text-accent hover:underline">{t("Open in Canvas")}</button>
      </div>
    );
  }

  /** The overview, right-clicked between the cards. (Hidden cards come back through 添加卡片.) */
  const overviewMenu = (): MenuItem[] => [
    { label: t("Add a card…"), onSelect: () => setAdding(true) },
  ];
  /** A card, right-clicked: what's to do with it, and with it as a card. */
  const cardMenu = (e: Shown): MenuItem[] => sections(
    isOwn(e) ? things.markRead(e) : things.ways(e),
    cardPlace.menu(e, { hide: t("Hide “{name}”", { name: titleOf(e) }), takeAway: t("Remove card"), danger: true }),
    [pinItem(things, e)],
    isView(e, "tools") ? [{ label: t("Add a link…"), onSelect: () => setAddingLink(true) }] : [],
  );

  const markRead = (n: number, of: NewsView) => (n > 0 ? { label: t("Mark read"), onClick: () => onMarkSeen(of) } : undefined);
  const more = (name: Parameters<typeof view>[1]) => () => things.open(view(course.id, name));
  const moduleItems = (m: Module, limit = 10) => (
    <>
      <ul>
        {m.items.slice(0, limit).map((it, i) => (
          <ModuleRow key={it.id ?? i} it={{ ...it, indent: 0 }} course={course.id} opening={!!it.tool && pending === `item:${it.tool.module_item_id}`} onClick={() => activate(it)} />
        ))}
      </ul>
      {m.items.length > limit && (
        <button onClick={() => things.open({ type: "module", course: course.id, module: m.id })} className="px-2 py-1 text-xs text-muted hover:text-fg">{tn("1 more ›", "{n} more ›", { n: m.items.length - limit })}</button>
      )}
    </>
  );

  // Where each card goes, as it would be if what's dragged were let go now.
  const order = [...drag.preview(keys)]; // (a copy: `keys` is what each card is)
  const dragged = drag.dragging !== null ? keys[drag.dragging] : null;
  const { spots, height } = stack(order, heights, columns, was.current.cols, dragged ? { [dragged]: dropColumn.current } : {});
  if (!dragged && columns > 1) { // (held while dragging; one column, when narrow, isn't where you put them)
    const cols = Object.fromEntries(Object.entries(spots).map(([k, s]) => [k, s.col]));
    if (JSON.stringify(cols) !== JSON.stringify(was.current.cols)) saveColumns(course.id, (was.current.cols = cols));
  }
  const inColumn = (col: number): React.CSSProperties => ({
    position: "absolute",
    left: columns === 1 ? 0 : `calc(${col} * (50% + ${GAP / 2}px))`,
    width: columns === 1 ? "100%" : `calc(50% - ${GAP / 2}px)`,
  });
  const spot = (key: string): React.CSSProperties => ({ ...inColumn(spots[key].col), top: spots[key].top });

  // Each card: its header links, and what's in it.
  const spec = (e: Shown): { more?: () => void; action?: { label: string; onClick: () => void }; body: React.ReactNode } => {
    if (e.type === "view" && isOwn(e)) {
      switch (e.view) {
        case "assignments":
          return {
            more: counts.assignments ? more("assignments") : undefined, action: markRead(overview.new.assignments, "assignments"),
            body: upcoming.length === 0 ? <Empty>{t("Nothing due in the next three weeks")}</Empty>
              : upcoming.map((a) => <AssignmentRow key={a.id} a={a} course={course.id} onClick={() => things.open(docThing(course.id, a))} />),
          };
        case "announcements":
          return {
            more: counts.announcements ? more("announcements") : undefined, action: markRead(overview.new.announcements, "announcements"),
            body: announcements.length === 0 ? <Empty>{t("No announcements yet")}</Empty> : announcements.map((a) => (
              <Row key={a.id} onClick={() => things.open(docThing(course.id, a))} thing={docThing(course.id, a)}>
                <div className="flex items-center gap-2">
                  {a.new && <NewDot label={t("New announcement")} />}
                  <span className={`truncate ${a.new ? "font-medium" : ""}`}>{a.title}</span>
                  <SourceTag source={a.source} />
                  <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(a.date, false)}</span>
                </div>
                {a.preview && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{a.preview}</p>}
              </Row>
            )),
          };
        case "ed":
          return {
            more: more("ed"), action: markRead(overview.new.ed, "ed"),
            body: ed.length === 0 ? <Empty>{t("Nothing pinned, announced or from staff on Ed")}</Empty> : ed.map((p) => (
              <Row key={p.id} onClick={() => things.openIn(docThing(course.id, p), "ed")} thing={docThing(course.id, p)}>
                <div className="flex items-center gap-2">
                  {p.new && <NewDot />}
                  {p.ed?.pinned && <Pin className="size-3 shrink-0 text-muted" aria-label={t("Pinned")} />}
                  {p.kind === "announcement" && <EdAnnouncementMark />}
                  <span className={`truncate ${p.new ? "font-medium" : ""}`}>{p.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(p.date, false)}</span>
                </div>
                {p.preview && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{p.preview}</p>}
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
            more: more("files"), action: markRead(overview.new.files, "files"),
            body: new_files.length === 0 ? <Empty>{t("No files yet")}</Empty> : new_files.map((f) => (
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
                    <p className="mt-0.5 text-xs text-muted">{t("Current grade (graded work only)")}</p>
                  </div>
                )}
                {grades.recent.length > 0 && <h3 className="px-2 pt-1 text-[11px] font-medium text-muted">{t("Recently graded")}</h3>}
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
            body: <LinksList course={course} place={linkPlace} onAdd={() => setAddingLink(true)} />,
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
        return { body: <Row onClick={() => things.open(e)} thing={e}><span className="text-muted">{t("Open ›")}</span></Row> };
    }
  };

  return (
    <div ref={zone.ref} className="min-h-0 flex-1 overflow-y-auto" onContextMenu={(e) => (e.preventDefault(), things.menu(overviewMenu(), e.clientX, e.clientY))}>
      <div className="mx-auto max-w-5xl px-6 pt-4 pb-6">
        {shown.length === 0 && <p className="py-10 text-center text-sm text-muted">{t("Every card is hidden. Add some with “Add a card” below.")}</p>}
        <div
          ref={setGrid}
          className={`relative rounded-xl ${zone.state === "ready" ? "outline-1 outline-offset-4 outline-dashed outline-accent/60" : ""}`}
          style={{ height: Math.max(48, height), transition: placed ? `height ${GLIDE}` : undefined }}
        >
          {inserting && (
            <div aria-hidden className="pointer-events-none z-10 h-0.5 rounded-full bg-accent"
              style={{ ...inColumn(dropColumn.current), top: lineIn(keys.map((k) => ({ ...spots[k], height: heights[k] ?? 0 })), dropColumn.current, zone.slot, GAP) - 1 }} />
          )}
          {shown.map((e, i) => {
            const s = spec(e);
            return (
              <Card
                key={keys[i]}
                cardKey={keys[i]}
                style={spot(keys[i])}
                flash={fresh === keys[i]}
                cardRef={drag.ref(i)}
                grab={drag.handle(i)}
                title={titleOf(e)}
                editor={cardPlace.isRenaming(e)
                  ? <RenameInput initial={titleOf(e)} onSubmit={(title) => cardPlace.rename(e, title)} onCancel={cardPlace.cancelRename} className="h-5 flex-1 text-sm" />
                  : undefined}
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
        <div className="mt-4 flex justify-center">
          <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-chip hover:text-fg">
            <Plus className="size-3.5" />
            {t("Add a card")}
          </button>
        </div>
      </div>

      {adding && (
        <AddCardDialog
          course={course}
          hidden={all.filter((e): e is Shown & { type: "view" } => !!e.hidden && e.type === "view" && isOwn(e))
            .map((e) => ({ entry: e, title: titleOf(e), available: available(e) }))}
          onClose={() => setAdding(false)}
          onAdd={(entry) => {
            setAdding(false);
            add(entry);
          }}
        />
      )}
      {addingLink && (
        <LinkDialog onClose={() => setAddingLink(false)} onAdd={(link) => (setAddingLink(false), linkPlace.put({ type: "link", url: link.url, title: link.title }))} />
      )}
    </div>
  );
}

function Card({ cardKey, style, flash, title, editor, icon, more, action, cardRef, grab, onMenu, children }: {
  cardKey: string;
  style: React.CSSProperties;
  flash: boolean; // just added: outlined for a moment
  title: string;
  editor?: React.ReactNode; // being renamed: the input, in its title's place
  icon: React.ReactNode;
  more?: () => void;
  action?: { label: string; onClick: () => void };
  cardRef: (el: HTMLElement | null) => void;
  grab: { onPointerDown: (e: React.PointerEvent) => void };
  onMenu: (x: number, y: number) => void;
  children: React.ReactNode;
}) {
  return (
    <section
      ref={cardRef} data-card={cardKey} data-flip={cardKey} data-home style={style} className="rounded-xl border border-line bg-panel"
      onContextMenu={(e) => {
        e.stopPropagation(); // (not the overview's menu)
        if (keepsOwnMenu(e)) return;
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      {flash && <span aria-hidden className="pointer-events-none absolute -inset-px z-10 animate-[fade-out_2s_ease-in_forwards] rounded-[inherit] ring-2 ring-accent" />}
      <header
        {...grab}
        title={t("Drag the title to move this card; right-click to rename or hide it")}
        className="flex cursor-grab items-center gap-2 px-4 pt-3 pb-1.5 text-sm font-medium active:cursor-grabbing"
      >
        <span className="text-muted">{icon}</span>
        {editor ?? <span className="truncate">{title}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-xs font-normal">
          {action && <button onClick={action.onClick} className="text-muted hover:text-fg">{action.label}</button>}
          {more && <button onClick={more} className="text-muted hover:text-fg">{t("All ›")}</button>}
        </span>
      </header>
      <div className="px-2 pb-2">{children}</div>
    </section>
  );
}

/** 工具与链接's rows: the course's tools, its syllabus, Canvas, and what you put there. Drag them
 * into your order, or anything in among them; drag one you put there off to take it away.
 * Right-click one to rename it, hide it (the course's own) or delete it (what you put there). */
function LinksList({ course, place, onAdd }: {
  course: Course;
  place: Place; // (useLinks)
  onAdd: () => void; // asks for a link to add
}) {
  const things = useThings();
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const { shown } = place;
  const name = (e: Shown) => thingName(e, things.courses);
  const menu = (e: Shown): MenuItem[] => sections(
    things.ways(e),
    place.menu(e, { hide: t("Hide “{name}”", { name: name(e) }), takeAway: t("Remove link"), danger: true }),
    [pinItem(things, e)],
  );
  // Dragged in from elsewhere: it goes where the link it's over (or nearest) was when it came
  // over the list; judged by what's drawn, the links making room would change the answer.
  const before = useRef<{ left: number; top: number; width: number; height: number }[] | null>(null);
  const slotAt = (x: number, y: number) => {
    if (!box) return shown.length;
    before.current ??= Array.from(box.querySelectorAll<HTMLElement>(":scope > [data-link]"))
      .map((el) => ({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }));
    const r = box.getBoundingClientRect();
    const i = nearest(before.current.map((b) => ({ ...b, left: r.left + b.left, top: r.top + b.top })), x, y);
    if (i < 0) return shown.length;
    const b = before.current[i]; // (past the middle of the last one: after it)
    return i === before.current.length - 1 && x > r.left + b.left + b.width / 2 ? shown.length : i;
  };
  const { zone, drag } = usePlaceDrag(place, "cards", {
    slotAt, accepts: (e) => ofCourse(e, course) && !isView(e, "overview") && !isView(e, "tools"),
  });
  useEffect(() => {
    if (zone.state !== "over") before.current = null;
  }, [zone.state]);
  useFlip(box, true);
  // Drawn as they'd be if what's dragged were let go now: moved among them, or a slot for it.
  const order: (number | null)[] = drag.preview(shown.map((_, i) => i));
  if (zone.state === "over") order.splice(Math.min(zone.slot, order.length), 0, null);
  return (
    <div ref={(el) => {
      setBox(el);
      zone.ref(el);
    }} className="relative flex flex-wrap rounded-md"
      onContextMenu={(ev) => (ev.preventDefault(), ev.stopPropagation(), things.menu(linksMenu(place, onAdd, things.courses), ev.clientX, ev.clientY))}>
      {order.map((i) => i === null ? (
        <div key={DROP} aria-hidden data-link data-placeholder data-flip={DROP} className="h-8 w-28 rounded-md" />
      ) : (
        <div key={thingKey(shown[i])} data-link data-flip={thingKey(shown[i])} className="relative rounded-md" {...drag.item(i)}
          onContextMenu={(ev) => {
            ev.stopPropagation();
            if (keepsOwnMenu(ev)) return;
            ev.preventDefault();
            things.menu(menu(shown[i]), ev.clientX, ev.clientY);
          }}>
          {place.isRenaming(shown[i]) ? (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
              <span className="text-muted"><ThingIcon thing={shown[i]} courses={things.courses} /></span>
              <RenameInput initial={name(shown[i])} onSubmit={(title) => place.rename(shown[i], title)} onCancel={place.cancelRename} className="h-5 w-40 text-sm" />
            </div>
          ) : (
            <Row onClick={() => things.open(shown[i])}>
              <span className="flex items-center gap-2">
                <span className="text-muted"><ThingIcon thing={shown[i]} courses={things.courses} /></span>
                {name(shown[i])}
                {things.opening === thingKey(shown[i]) && <span className="text-xs text-muted">{t("Opening…")}</span>}
              </span>
            </Row>
          )}
        </div>
      ))}
      <div data-flip="add">
        <Row onClick={onAdd}>
          <span className="flex items-center gap-2 text-muted"><Plus className="size-4" />{t("Add a link")}</span>
        </Row>
      </div>
    </div>
  );
}

/** 工具与链接 right-clicked where there's no link: add one, show the hidden ones again. */
function linksMenu(place: Place, onAdd: () => void, courses: Course[]): MenuItem[] {
  return sections(
    [{ label: t("Add a link…"), onSelect: onAdd }],
    place.entries.filter((x) => x.hidden).map((x) => ({ label: t("Show “{name}”", { name: thingName(x, courses) }), onSelect: () => place.show(x) })),
  );
}

/** Right-clicked in text you type or select: the system's menu (copy, paste). */
function keepsOwnMenu(e: React.MouseEvent) {
  const el = e.target as HTMLElement;
  const sel = window.getSelection();
  return !!el.closest("input, textarea, [contenteditable]") || (!!sel?.toString() && sel.containsNode(el, true));
}

/** 工具与链接 as a tab of its own. */
export function LinksPage({ course, links, syllabus, onArrange, onSay }: {
  course: Course;
  links: Shown[];
  syllabus: boolean; // the course has one
  onArrange: (next: Shown[]) => void;
  onSay: Say;
}) {
  const things = useThings();
  const [adding, setAdding] = useState(false);
  const place = useLinks(links, syllabus, onArrange, onSay);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto"
      onContextMenu={(e) => (e.preventDefault(), things.menu(linksMenu(place, () => setAdding(true), things.courses), e.clientX, e.clientY))}>
      <div className="mx-auto max-w-3xl px-6 py-6">
        <LinksList course={course} place={place} onAdd={() => setAdding(true)} />
      </div>
      {adding && <LinkDialog onClose={() => setAdding(false)} onAdd={(link) => (setAdding(false), place.put({ type: "link", url: link.url, title: link.title }))} />}
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
        {isNew && <NewDot label={updated ? t("New version") : t("New file")} />}
        {updated && <span className="shrink-0 rounded bg-info-soft px-1.5 text-[11px] text-info">{t("Updated")}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(date, false)}</span>
        <button
          title={t("Show in folder")}
          aria-label={t("Show in folder")}
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
  const { value: entries, error } = useLoaded(`tree:${path}`, () => api.tree(path));
  if (error) return <Empty>{t("This folder is gone")}</Empty>;
  if (!entries) return <Loading className={LOADING} />;
  const live = entries.filter((e) => !e.deleted);
  if (!live.length) return <Empty>{t("This folder is empty")}</Empty>;
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
        <button onClick={() => things.open({ type: "folder", path })} className="px-2 py-1 text-xs text-muted hover:text-fg">{tn("1 more ›", "{n} more ›", { n: sorted.length - 12 })}</button>
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
        <span className="text-xs text-muted">{t("Click to open")}</span>
      </span>
    </button>
  );
}

/** A note: typed here, saved as you go (in the sync folder, .canvas/notes). On a card, or as a
 * tab of its own (`page`). */
export function NoteEditor({ course, id, page = false }: { course: number; id: string; page?: boolean }) {
  const key = `note:${course}:${id}`;
  const loaded = useLoaded(key, () => api.note(course, id).then((n) => n.text, () => "")).value;
  const [typed, setTyped] = useState<string | null>(null); // (once typed in, what's typed counts)
  const text = typed ?? loaded ?? null;
  const [state, setState] = useState<"saved" | "saving" | "failed">("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef("");
  // Saves what's pending when it goes away (another tab, another course).
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void api.saveNote(course, id, latest.current);
    }
  }, [course, id]);
  const change = (v: string) => {
    setTyped(v);
    remember(key, v);
    latest.current = v;
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      api.saveNote(course, id, v).then(() => setState("saved"), () => setState("failed"));
    }, 500);
  };
  if (text === null) return <Loading className={LOADING} />;
  return (
    <div className={page ? "flex min-h-0 flex-1 flex-col px-6 py-4" : "px-2 pb-1"} data-no-drag>
      <textarea
        value={text}
        onChange={(e) => change(e.target.value)}
        placeholder={t("Write something: what's on the exam, office hours, questions to ask…")}
        rows={page ? undefined : Math.min(14, Math.max(4, text.split("\n").length + 1))}
        className={`selectable w-full rounded-md border border-transparent bg-chip/50 px-2.5 py-2 text-sm leading-relaxed outline-none focus:border-line ${page ? "mx-auto max-w-3xl flex-1 resize-none" : "resize-y"}`}
      />
      <p className={`text-right text-[11px] text-muted ${page ? "mx-auto w-full max-w-3xl pt-1" : ""}`}>
        {state === "saving" ? t("Saving…") : state === "failed" ? t("Couldn't save; try again in a moment") : t("Saved")}
      </p>
    </div>
  );
}

/** A page (or an announcement, an assignment, the syllabus), right on the overview: where some
 * instructors keep the schedule. */
function DocCard({ course, kind, id }: { course: Course; kind: DocKind; id: string }) {
  const { value: item, error } = useLoaded(`item:${course.id}:${kind}:${id}`, () => api.item(course.id, kind, id));
  if (error) return <Empty>{t("This page isn't there (it may have been deleted, or isn't synced yet)")}</Empty>;
  if (!item) return <Loading className={LOADING} />;
  return (
    <div className="max-h-96 overflow-y-auto px-2 pb-1" data-no-drag>
      {item.html.trim() ? <RichText html={item.html} files={item.files} /> : <Empty>{t("Nothing written here.")}</Empty>}
    </div>
  );
}

/** One module, always: "Exam review", "Course resources". */
function ModuleCard({ course, id, render }: { course: number; id: number; render: (m: Module, limit?: number) => React.ReactNode }) {
  const modules = useLoaded(`modules:${course}`, () => api.modules(course).catch((): Module[] => [])).value;
  if (modules === undefined) return <Loading className={LOADING} />;
  const module = modules.find((m) => m.id === id);
  if (!module) return <Empty>{t("This module isn't there any more")}</Empty>;
  return <>{render(module, 12)}</>;
}

/** A saved search: everything with "mt" in its name, say. */
function SearchCard({ search }: { search: ThingOf<"search"> }) {
  const things = useThings();
  const { query, courses, kinds, content } = search;
  const hits = useLoaded(`search:${JSON.stringify([query, courses, kinds, content])}`,
    () => api.search(query, { courses, kinds, namesOnly: !content, limit: 12 }).catch((): Hit[] => [])).value;
  if (!hits) return <Loading className={LOADING} />;
  if (!hits.length) return <Empty>{t("No results")}</Empty>;
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
      title={t("Add a link")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button primary disabled={!ok} onClick={add}>{t("Add")}</Button>
        </>
      }
    >
      <div className="space-y-3 pb-2" onKeyDown={(e) => e.key === "Enter" && add()}>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("Website URL")}</span>
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoCorrect="off" autoCapitalize="off" spellCheck={false} className={input} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("Name (optional)")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("e.g. Course website")} className={input} />
        </label>
      </div>
    </Dialog>
  );
}
