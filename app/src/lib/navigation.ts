// Where the main window is (all files, a course's page on one of its tabs, a smart folder,
// settings), the history of that, and how a course's page gets from one thing to another: to a
// tab, to the tab that shows a thing, to the tab at the end (a new tab, or something shown that
// isn't one of its tabs) and back. Just the rules, as functions of where it is and the course's
// tabs; MainWindow.tsx keeps the state and does the going.
import type { DocKind } from "./api";
import { type Shown, type Thing, type ThingOf, type ViewName, fromEd, isView, opensElsewhere, same, thingKey, thingOf, view as viewOf } from "./things";

// A course is its own kind of place, not "a folder": it opens on its first tab (概览, usually), or
// where you last were in it.
// `tab` is the thing the course's page shows (one of its views, or anything put there as a tab);
// `path` is the folder 文件 (or a folder tab) is in; `item` the announcement / assignment / page
// being read, or the module open in 模块. A search is a smart folder (a saved search) shown.
// `found`: what's marked there, having come from search (lib/marks.ts).
// `blank`: a new tab is showing (`tab` is the one before it, to go back to when it's closed).
export type CourseView = { kind: "course"; id: number; tab: Thing; path: string; select?: string; item?: string; first?: boolean; found?: string; blank?: boolean };
export type View =
  | CourseView // first: opened on its first tab
  | { kind: "browse"; path: string; select?: string; found?: string }
  | { kind: "search"; search: ThingOf<"search">; found?: string }
  | { kind: "settings"; found?: undefined };

/** Where each kind of document is listed. */
export const KIND_VIEW: Record<DocKind, ViewName> = {
  announcement: "announcements", assignment: "assignments", page: "pages", syllabus: "syllabus", post: "ed",
};
/** What each view that's a reader lists: a kind of document, or everything from Ed, whatever its kind. */
export const VIEW_LISTS: Partial<Record<ViewName, DocKind | "ed">> = {
  announcements: "announcement", assignments: "assignment", pages: "page", syllabus: "syllabus", ed: "ed",
};

/** Whether a path is in a folder (or is it; "": the sync folder, which everything is in). */
export const under = (path: string, dir: string) => dir === "" || path === dir || path.startsWith(dir + "/");

// -- the history ----------------------------------------------------------------------------------

export type History = { stack: View[]; i: number };
export const START: History = { stack: [{ kind: "browse", path: "" }], i: 0 };
/** Somewhere new: what was ahead (after going back) is dropped. */
export const went = (h: History, v: View): History => ({ stack: [...h.stack.slice(0, h.i + 1), v], i: h.i + 1 });
/** Back (-1) or forward (1), as far as there is. */
export const stepped = (h: History, d: number): History => ({ ...h, i: Math.max(0, Math.min(h.stack.length - 1, h.i + d)) });
/** Where it is, changed without a new entry (picking an item in a list). */
export function replaced(h: History, v: View): History {
  const stack = [...h.stack];
  stack[h.i] = v;
  return { ...h, stack };
}

// -- a course's tabs --------------------------------------------------------------------------------

/** Whether a thing is one of the tabs showing. */
export const listed = (tabs: Shown[], x: Thing) => tabs.some((e) => same(e, x) && !e.hidden);

/** Going to one of the course's tabs (or showing something there). `dir`: the course's folder. A
 * folder tab is at its folder; 文件 starts at the course's, and so does clicking it again. */
export function toTab(v: CourseView, x: Thing, dir: string | undefined): CourseView {
  const fresh = v.tab.type === "folder" || x.type === "folder" || (same(v.tab, x) && !v.blank);
  return { ...v, tab: x, item: undefined, select: undefined, first: false, found: undefined, blank: false, path: x.type === "folder" ? x.path : fresh ? dir ?? v.path : v.path };
}

/** The first tab that shows something here (not one that opens a file, a tool or a link). */
export const firstTab = (tabs: Shown[], id: number): Thing => thingOf(tabs.find((e) => !e.hidden && !opensElsewhere(e)) ?? viewOf(id, "overview"));

/** Where the course's page is, once its tabs are known: a thing it has a tab for is that tab; a
 * document, a module, a folder is in the view that has it (the reader with it picked, 模块 at it,
 * 文件 or a folder tab at it), if that's one of its tabs. Else it shows on a tab for now (`spareOf`). */
export function settle(v: CourseView, tabs: Shown[], dir: string | undefined): CourseView {
  if (v.first) return { ...toTab(v, firstTab(tabs, v.id), dir), found: v.found };
  const x = v.tab;
  if (listed(tabs, x)) return v;
  if (x.type === "doc" && x.course === v.id && listed(tabs, viewOf(v.id, KIND_VIEW[x.kind]))) {
    return { ...v, tab: viewOf(v.id, KIND_VIEW[x.kind]), item: x.id };
  }
  if (x.type === "module" && x.course === v.id && listed(tabs, viewOf(v.id, "modules"))) {
    return { ...v, tab: viewOf(v.id, "modules"), item: String(x.module) };
  }
  if (x.type === "folder") {
    const holder = tabs.filter((e) => e.type === "folder" && !e.hidden && under(x.path, e.path))
      .sort((a, b) => (b as ThingOf<"folder">).path.length - (a as ThingOf<"folder">).path.length)[0];
    if (holder) return { ...v, tab: thingOf(holder), path: x.path };
    if (listed(tabs, viewOf(v.id, "files"))) return { ...v, tab: viewOf(v.id, "files"), path: x.path };
  }
  return v;
}

/** The one place at the end of a course's tabs: a new tab, or something shown that isn't one of
 * its tabs (a temporary tab). It stays while you go to other tabs, until closed. */
export type Spare = Thing | "new";
export const spareKey = (s: Spare | null | undefined) => (!s ? "" : s === "new" ? s : thingKey(s));

/** What the page showing puts in the tab at the end: the new tab; what it shows, if that's none of
 * the tabs (`settled`: they're known, and it's where they say: see `settle`); nothing. */
export const spareOf = (v: CourseView, tabs: Shown[], settled: boolean): Spare | null =>
  v.blank ? "new" : !settled || listed(tabs, v.tab) ? null : v.tab;

/** Where the page is once the tab at the end, showing, is closed: back on the tab you were on
 * before it (a new tab's `tab`, or `last`: the one last shown), if that's still a tab; else the
 * first one. */
export function withoutSpare(v: CourseView, tabs: Shown[], last: Thing | undefined, dir: string | undefined): CourseView {
  const before = [v.blank ? v.tab : null, last].find((x) => x && listed(tabs, x));
  if (v.blank && before && same(before, v.tab)) return { ...v, blank: false };
  return toTab(v, before ?? firstTab(tabs, v.id), dir);
}

// -- what's on screen -------------------------------------------------------------------------------

/** Whether files are showing: all files, or a course's 文件 (or a folder that's a tab). */
export const showsFiles = (v: View) => v.kind === "browse" || (v.kind === "course" && !v.blank && (isView(v.tab, "files") || v.tab.type === "folder"));

/** Whether a thing is what's on screen: a course's tab, the announcement or page being read, the
 * module open in 模块, the folder 文件 is in, the smart folder. */
export function showing(v: View, x: Thing): boolean {
  if (v.kind === "search") return same(x, v.search);
  if (x.type === "folder") return showsFiles(v) && (v.kind === "browse" || v.kind === "course") && v.path === x.path;
  if (v.kind !== "course") return false;
  if (same(x, v.tab)) return true;
  if (x.type === "doc") return x.course === v.id && (isView(v.tab, KIND_VIEW[x.kind]) || (isView(v.tab, "ed") && fromEd(x))) && v.item === x.id;
  if (x.type === "module") return x.course === v.id && isView(v.tab, "modules") && v.item === String(x.module);
  return false;
}
