// Things on screen (see lib/things.ts): what each is called and its icon, how it opens, and what
// you can do with it wherever it shows: press and drag it to a place (置顶, a course's tabs, its
// overview, 工具与链接), or right-click it. The main window provides the doing (ThingsContext).
import {
  AppWindow, Award, BookOpen, ClipboardList, ExternalLink, FileText, Folder, FolderOpen, GraduationCap, LayoutDashboard,
  Link as LinkIcon, ListChecks, Megaphone, MessagesSquare, NotebookPen, ScrollText, Sparkles,
} from "lucide-react";
import { createContext, createElement, useContext } from "react";
import type { Course } from "../lib/api";
import { CourseIcon } from "../lib/courseIcons";
import { t } from "../lib/i18n";
import { dragToPlace } from "../lib/dropZones";
import { type Shown, type Thing, type ViewName, isView, opensElsewhere } from "../lib/things";
import { FileIcon } from "./FileIcon";
import type { MenuItem } from "./Menu";

export interface Things {
  courses: Course[];
  /** Wherever it opens: here (a page, a folder, a course's view), in its app, in the browser. */
  open: (thing: Thing) => void;
  showInFolder: (path: string) => void; // a file, selected in its folder (in the app)
  opening: string | null; // what's on its way (a tool: Canvas is making a link), by thingKey
  /** What can be done with it, besides placing it: 打开, 在文件夹中显示, 在 Canvas 中打开... */
  ways: (thing: Thing) => MenuItem[];
  isPinned: (thing: Thing) => boolean;
  pin: (entry: Shown) => void;
  unpin: (thing: Thing) => void;
  menu: (items: MenuItem[], x: number, y: number) => void;
}

export const ThingsContext = createContext<Things | null>(null);
export const useThings = () => useContext(ThingsContext)!;

/** 置顶, or 取消置顶 if it is. */
export function pinItem(things: Things, entry: Shown): MenuItem {
  return things.isPinned(entry)
    ? { label: t("取消置顶"), onSelect: () => things.unpin(entry) }
    : { label: t("置顶"), onSelect: () => things.pin(entry) };
}

const noDrag = (e: React.PointerEvent) => !!(e.target as HTMLElement).closest("input, textarea, select, [data-no-drag]");

/** `thing(entry, more)`: props for an element that shows a thing: press and drag it to a place;
 * right-click it for what can be done with it, then `more`, then 置顶. No entry: nothing. */
export function useThing() {
  const things = useContext(ThingsContext);
  return (entry: Shown | null | undefined, more: MenuItem[] = []) => {
    if (!things || !entry) return {};
    return {
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => !noDrag(e) && dragToPlace(e, e.currentTarget, entry),
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        things.menu(sections(things.ways(entry), more, [pinItem(things, entry)]), e.clientX, e.clientY);
      },
    };
  };
}

/** A folder or file in the sync folder, as a thing (a course's own folder is the course). */
export function thingOfEntry(e: { type: "dir" | "file"; path: string }, courses: Course[]): Thing {
  if (e.type === "file") return { type: "file", path: e.path };
  const c = courses.find((x) => x.dir === e.path);
  return c ? { type: "course", course: c.id } : { type: "folder", path: e.path };
}

/** Just the dragging, for things with menus of their own (that offer 置顶 themselves). */
export function useDragThing() {
  return (entry: Shown | null | undefined) =>
    entry ? { onPointerDown: (e: React.PointerEvent<HTMLElement>) => !noDrag(e) && dragToPlace(e, e.currentTarget, entry) } : {};
}

/** Menu sections, with a separator between those that have anything. */
export function sections(...parts: MenuItem[][]): MenuItem[] {
  return parts.filter((p) => p.length).flatMap((p, i) => (i ? ["separator" as const, ...p] : p));
}

// -- what things are called -----------------------------------------------------------------------

/** A course's views, as tabs. */
export const VIEW_LABEL: Record<ViewName, string> = {
  overview: t("概览"), modules: t("模块"), announcements: t("公告"), discussion: t("讨论"), assignments: t("作业"), grades: t("成绩"),
  files: t("文件"), syllabus: t("大纲"), pages: t("页面"), tools: t("工具与链接"), canvas: t("在 Canvas 中打开"),
};
/** A course's views, as cards on its overview. */
export const CARD_LABEL: Partial<Record<ViewName, string>> = {
  assignments: t("近期截止"), announcements: t("最新公告"), discussion: t("讨论区"), modules: t("当前模块"),
  files: t("最近新增的文件"), syllabus: t("课程大纲"),
};
/** As a row (in the sidebar, in 工具与链接). */
const ROW_LABEL: Partial<Record<ViewName, string>> = { syllabus: t("课程大纲") };
const DOC_LABEL = { announcement: t("公告"), assignment: t("作业"), page: t("页面@@card"), post: t("帖子") };

export type Where = "tab" | "card" | "row";

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** What a thing is called here: the name you gave it here, else its own. */
export function thingName(e: Shown, courses: Course[], where: Where = "row"): string {
  return e.title || ownName(e, courses, where);
}

/** What a thing is called by itself (what Canvas or the sync folder calls it, else what the app does). */
export function ownName(e: Shown, courses: Course[], where: Where = "row"): string {
  switch (e.type) {
    case "course": return courses.find((c) => c.id === e.course)?.label ?? e.name ?? t("课程 #{id}", { id: e.course });
    case "folder": case "file": return e.path.split("/").pop() ?? e.path;
    case "doc": return e.name || DOC_LABEL[e.kind];
    case "module": return e.name || t("模块@@card");
    case "tool": return e.name || t("外部工具");
    case "link": return host(e.url);
    case "search": return e.query ? `“${e.query}”` : t("搜索");
    case "note": return t("备忘录");
    case "view": return (where === "card" ? CARD_LABEL[e.view] : where === "row" ? ROW_LABEL[e.view] : undefined) ?? VIEW_LABEL[e.view];
  }
}

const VIEW_ICON: Record<ViewName, typeof Megaphone> = {
  overview: LayoutDashboard, modules: ListChecks, announcements: Megaphone, discussion: MessagesSquare, assignments: ClipboardList, grades: Award,
  files: FolderOpen, syllabus: ScrollText, pages: BookOpen, tools: AppWindow, canvas: ExternalLink,
};
const DOC_ICON = { announcement: Megaphone, assignment: ClipboardList, page: BookOpen, post: MessagesSquare };

export function ThingIcon({ thing, courses, className = "size-4" }: { thing: Thing; courses?: Course[]; className?: string }) {
  if (thing.type === "file") return <FileIcon name={thing.path} />;
  if (thing.type === "course") {
    const c = courses?.find((x) => x.id === thing.course);
    return c ? <CourseIcon course={c} /> : <GraduationCap className={className} />;
  }
  const icon = thing.type === "view" ? VIEW_ICON[thing.view]
    : thing.type === "doc" ? DOC_ICON[thing.kind]
      : { folder: Folder, module: ListChecks, tool: AppWindow, link: LinkIcon, search: Sparkles, note: NotebookPen }[thing.type];
  return createElement(icon ?? FileText, { className: `${className} shrink-0` });
}

/** What opening a web address says: on Canvas for the site's own (relative) ones, else where. */
export function onTheWeb(url: string): string {
  if (url.startsWith("/")) return t("在 Canvas 中打开");
  return /(^|\.)edstem\.org$/.test(new URL(url).hostname) ? t("在 Ed 中打开") : t("在浏览器中打开");
}

/** Where a document came from, when not Canvas: a small tag beside its title. */
export function SourceTag({ source }: { source?: string }) {
  if (source !== "ed") return null;
  return <span title={t("来自 Ed")} className="shrink-0 rounded bg-chip px-1 text-[10px] text-muted">Ed</span>;
}

/** What a thing opens as, said on hover: a file in its app, a tool or link in the browser. */
export function opensHint(thing: Thing): string | undefined {
  if (!opensElsewhere(thing)) return undefined;
  if (thing.type === "file") return t("用默认应用打开");
  if (thing.type === "course") return undefined;
  if (thing.type === "tool") return t("在浏览器中打开这个工具（通过 Canvas 登录）");
  return isView(thing, "canvas") ? t("在 Canvas 中打开这门课") : t("在浏览器中打开");
}
