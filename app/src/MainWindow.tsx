import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronLeft, ChevronRight, FolderTree, LayoutGrid, List, MoreHorizontal, Plus, RefreshCw, Search, Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./components/Dialog";
import { FileBrowser, canRename, parentOf, type ViewMode } from "./components/FileBrowser";
import { FoundSearch, type How, actionsFor, canvasUrl, rememberCourse, useCatalog } from "./components/Found";
import {
  CourseDoc, CourseGrades, CourseModules, CourseReader, CourseTabs, KIND_VIEW, VIEW_KIND, useOverview,
} from "./components/CourseView";
import { CourseOverview, LinksPage, NoteEditor } from "./components/Overview";
import { DeleteDialog } from "./components/DeleteDialog";
import { CourseIconDialog } from "./components/CourseIconDialog";
import { HideCourseDialog } from "./components/HideCourseDialog";
import { HitBrowser } from "./components/HitBrowser";
import { ContextMenu, type MenuItem, type MenuState } from "./components/Menu";
import { KIND } from "./components/Result";
import { RenameDialog } from "./components/RenameDialog";
import { RestoreDialog } from "./components/RestoreDialog";
import { Settings } from "./components/Settings";
import { Count } from "./components/Status";
import { SmartFolderDialog, type SmartFolder } from "./components/SmartFolderDialog";
import {
  ThingIcon, ThingsContext, VIEW_LABEL, ownName, pinItem, sections, thingName, thingOfEntry, type Things,
} from "./components/Things";
import * as api from "./lib/api";
import type { AccountInfo, Course, CourseLayout, Entry, Hit, Kind, Place, Scope, SidebarOrder, SyncState } from "./lib/api";
import { useDropZone } from "./lib/dropZones";
import type { Found } from "./lib/find";
import { appCommand, fileManager, isMac, shortcut, trashName } from "./lib/keys";
import { usePref } from "./lib/prefs";
import { useSearch } from "./lib/useSearch";
import { CourseIcon } from "./lib/courseIcons";
import { moved, useReorder } from "./lib/reorder";
import { termRank } from "./lib/terms";
import {
  type Shown, type Thing, type ThingOf, type ViewName, changed, isView, opensElsewhere, putAt, same, thingKey, thingOf, thingOfHit,
  view as viewOf, without,
} from "./lib/things";
import { useTrafficLights } from "./lib/window";
import { friendly } from "./lib/errors";
import { t, tx } from "./lib/i18n";

// A course is its own kind of place, not "a folder": it opens on its first tab (概览, usually).
// `tab` is the thing the course's page shows (one of its views, or anything put there as a tab);
// `path` is the folder 文件 (or a folder tab) is in; `item` the announcement / assignment / page
// being read, or the module open in 模块. A search is a smart folder (a saved search) shown.
type CourseView = { kind: "course"; id: number; tab: Thing; path: string; select?: string; item?: string; first?: boolean };
type View =
  | { kind: "home" }
  | CourseView // first: opened on its first tab
  | { kind: "browse"; path: string; select?: string }
  | { kind: "search"; search: ThingOf<"search"> }
  | { kind: "settings" };

/** The open course's page: its places, each with all they hold (as last loaded, or as just changed). */
type Layout = { [P in Place]: Shown[] } & { own: CourseLayout["own"] };
const layouts = new Map<number, Layout>(); // each course's, as last loaded: drawn at once when it's opened again

function groupByTerm(list: Course[]): [string, Course[]][] {
  const groups = new Map<string, Course[]>();
  for (const c of list) {
    const term = c.term_label ?? t("无学期");
    groups.set(term, [...(groups.get(term) ?? []), c]);
  }
  return [...groups.entries()].sort(([a], [b]) => termRank(b) - termRank(a));
}

/** A term in the sidebar: `label` as you named it, `key` as Canvas does (what its place is saved by). */
type TermGroup = { label: string; key: string; courses: Course[] };

/** The sidebar's terms and courses as you dragged them. Terms you haven't placed (a new one)
 * come first, newest first; courses you haven't placed come last in their term. */
function arrange(list: Course[], order: SidebarOrder): TermGroup[] {
  const place = <T,>(saved: T[], k: T, unplaced: number) => (saved.includes(k) ? saved.indexOf(k) : unplaced);
  return groupByTerm(list)
    .map(([label, courses], i) => ({
      label,
      key: courses[0].term ?? "",
      i,
      courses: courses
        .map((c, j) => ({ c, j }))
        .sort((a, b) => place(order.courses, a.c.id, Infinity) - place(order.courses, b.c.id, Infinity) || a.j - b.j)
        .map(({ c }) => c),
    }))
    .sort((a, b) => place(order.terms, a.key, -1) - place(order.terms, b.key, -1) || a.i - b.i)
    .map(({ label, key, courses }) => ({ label, key, courses }));
}

const under = (path: string, dir: string) => dir === "" || path === dir || path.startsWith(dir + "/");
const RESTORABLE = new Set(["modified", "missing", "ignored"]);
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const countLabel = (names: string[]) => (names.length === 1 ? names[0] : t("{n} 项", { n: names.length }));
const listed = (list: Shown[], x: Thing) => list.some((e) => same(e, x) && !e.hidden);
// Views that narrow their own lists as you type in the search box.
const FILTERS_ITSELF: ViewName[] = ["announcements", "assignments", "pages", "modules", "grades"];

export function MainWindow() {
  const [courseList, setCourseList] = useState<Course[]>([]);
  const [pinned, setPinned] = useState<Shown[]>([]);
  const [hist, setHist] = useState<{ stack: View[]; i: number }>({ stack: [{ kind: "home" }], i: 0 });
  const [query, setQuery] = useState("");
  const [mode, setMode] = usePref<ViewMode>("viewMode", "list");
  const [showChanges, setShowChanges] = usePref("showChanges", false); // what you changed, in files
  const [sync, setSync] = useState<SyncState | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [order, setOrder] = useState<SidebarOrder>({ terms: [], courses: [] });
  const [collapsed, setCollapsed] = usePref<string[]>("sidebar-collapsed", []); // "pinned", "term:<term>"
  const [hiddenOpen, setHiddenOpen] = usePref("sidebar-hidden-open", false); // the hidden courses, folded at first
  const [hiding, setHiding] = useState<{ courses: Course[]; term?: string } | null>(null);
  const [choosingIcon, setChoosingIcon] = useState<Course | null>(null);
  const [layout, setLayout] = useState<{ id: number; layout: Layout } | null>(null); // the open course's page
  const keepLayout = (id: number, l: Layout) => {
    layouts.set(id, l);
    setLayout({ id, layout: l });
  };
  const [syncLabel, setSyncLabel] = useState("");
  const [changes, setChanges] = useState<Record<number, number>>({});
  const [version, setVersion] = useState(0);
  const [seenTick, setSeenTick] = useState(0); // you opened something: what's new changed
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [restoring, setRestoring] = useState<{ scope: Scope; label: string } | null>(null);
  const [deleting, setDeleting] = useState<{ paths: string[]; label: string } | null>(null);
  const [editing, setEditing] = useState<{ folder: SmartFolder | null; preset?: Partial<SmartFolder> } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null); // a folder being renamed in place
  const [renameDialog, setRenameDialog] = useState<{ path: string; title: string; current: string; hint?: string } | null>(null);
  const [renamingPin, setRenamingPin] = useState<Shown | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null); // a tool on its way, by thingKey
  const searchBox = useRef<HTMLInputElement>(null);
  const trafficLights = useTrafficLights();

  const raw = hist.stack[hist.i];
  const [wide, setWide] = useState(false); // searching the whole course, not just what the tab shows
  const go = useCallback((v: View) => {
    setQuery("");
    setWide(false);
    setHist((h) => ({ stack: [...h.stack.slice(0, h.i + 1), v], i: h.i + 1 }));
  }, []);
  const step = (d: number) => setHist((h) => ({ ...h, i: Math.max(0, Math.min(h.stack.length - 1, h.i + d)) }));
  /** Change where we are without a new history entry (picking an item in a list). */
  const replaceView = (v: View) =>
    setHist((h) => {
      const stack = [...h.stack];
      stack[h.i] = v;
      return { ...h, stack };
    });
  const refresh = () => setVersion((n) => n + 1);
  const seenChanged = () => setSeenTick((n) => n + 1);

  // -- data ------------------------------------------------------------------------
  useEffect(() => {
    api.courses().then(setCourseList, (e) => setStartupError(String(e.message ?? e)));
  }, [version, seenTick]);
  useEffect(() => void api.pinned().then(setPinned, () => {}), [version]);
  useEffect(() => void api.sidebarOrder().then(setOrder, () => {}), [version]);
  useEffect(() => void api.account().then(setAccount, () => {}), []);
  const finished = useRef<string | null>(null); // when the sync we last reloaded for ended
  useEffect(() => {
    void api.syncState().then((s) => {
      finished.current = s.finished_at;
      setSync(s);
    }, () => {});
  }, []);
  useEffect(() => {
    api.status().then((all) => {
      const counts: Record<number, number> = {};
      for (const s of all) if (s.states.some((x) => RESTORABLE.has(x))) counts[s.course_id] = (counts[s.course_id] ?? 0) + 1;
      setChanges(counts);
    }, () => {});
  }, [version]);

  // Files change behind our back (you edit them in other apps): look again on focus.
  useEffect(() => {
    const off = getCurrentWindow().onFocusChanged(({ payload }) => payload && refresh());
    return () => void off.then((f) => f());
  }, []);

  // While a sync runs, poll its progress; when it ends, reload what it changed. Otherwise look
  // now and then: the backend syncs by itself too (设置 → 自动同步).
  useEffect(() => {
    const timer = setInterval(async () => {
      const next = await api.syncState().catch(() => null);
      if (!next) return;
      setSync(next);
      if (!next.running && next.finished_at !== finished.current) {
        finished.current = next.finished_at;
        refresh();
      }
    }, sync?.running ? 500 : 15000);
    return () => clearInterval(timer);
  }, [sync?.running]);

  // Window-wide keys (back, forward, search, show changes), per platform; and the mouse's
  // back / forward buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = appCommand(e, typingIn(e.target));
      if (command === "back") step(-1);
      else if (command === "forward") step(1);
      else if (command === "search") searchBox.current?.focus();
      else if (command === "toggleChanges") setShowChanges(!showChanges);
      else if (command === "settings") go({ kind: "settings" });
      else return;
      e.preventDefault();
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) step(-1);
      else if (e.button === 4) step(1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showChanges]);

  // -- the open course's page: its tabs, overview and 工具与链接, arranged for it or as every course's --
  const courseById = (id: number) => courseList.find((c) => c.id === id) ?? null;
  const courseAt = (path: string) => courseList.find((c) => under(path, c.dir)) ?? null;
  const layoutId = raw.kind === "course" ? raw.id : null;
  useEffect(() => {
    if (layoutId === null) return;
    let live = true;
    api.courseLayout(layoutId).then((l) => live && keepLayout(layoutId, l), () => {});
    return () => {
      live = false;
    };
  }, [layoutId, version]);
  const courseLayout = layout && layout.id === layoutId ? layout.layout : layoutId !== null ? layouts.get(layoutId) ?? null : null;
  const tabs = courseLayout?.tabs ?? [];
  /** Going to one of the course's tabs (or showing something there). */
  const toTab = (v: CourseView, x: Thing): CourseView => {
    const c = courseById(v.id);
    const leaving = v.tab.type === "folder" || x.type === "folder"; // (a folder tab is at its folder; 文件 starts at the course's)
    return { ...v, tab: x, item: undefined, select: undefined, first: false, path: x.type === "folder" ? x.path : leaving ? c?.dir ?? v.path : v.path };
  };
  // The first tab that shows something here (not one that opens a file, a tool or a link).
  const firstTab = (list: Shown[], id: number): Thing => thingOf(list.find((e) => !e.hidden && !opensElsewhere(e)) ?? viewOf(id, "overview"));
  /** Where the course's page is, once its tabs are known: a thing it has a tab for is that tab;
   * a document, a module, a folder is in the view that has it (the reader with it picked, 模块 at
   * it, 文件 or a folder tab at it), if that's one of its tabs. Else it shows on a tab for now. */
  const settle = (v: CourseView): CourseView => {
    if (!courseLayout || layout?.id !== v.id) return v;
    if (v.first) return toTab(v, firstTab(tabs, v.id));
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
  };
  const view: View = raw.kind === "course" ? settle(raw) : raw;
  const cv = view.kind === "course" ? view : null;
  // The course you were last in: search (here and in the search window) puts its things a little first.
  useEffect(() => {
    if (cv) rememberCourse(cv.id);
  }, [cv?.id]);
  const course = cv ? courseById(cv.id) : null;
  const tab = cv?.tab ?? null;
  const tabEntry = tab ? tabs.find((e) => same(e, tab)) ?? tab : null;
  const filesTab = view.kind === "browse" || (!!tab && (isView(tab, "files") || tab.type === "folder"));
  const filesView = view.kind === "browse" || view.kind === "course"; // has a search box for where it is
  const browsing = filesView ? view.path : null;
  const folderShown = filesTab ? browsing : null; // a course's other tabs remember a folder, but don't show it

  /** Go to a folder: inside a course, that's the course's page (in 文件, or a folder tab that has
   * it); elsewhere, a plain folder. */
  const goPath = (path: string, select?: string) => {
    const c = courseAt(path);
    if (!c) return go({ kind: "browse", path, select });
    // (In 文件, or a folder tab that has it: it stays there.)
    const stay = cv && cv.id === c.id && tab && (isView(tab, "files") || (tab.type === "folder" && under(path, tab.path)));
    go({ kind: "course", id: c.id, tab: stay ? tab : { type: "folder", path }, path, select });
  };
  /** Go into a folder from the one showing: 全部文件 stays 全部文件, even in a course's folder. */
  const goFolder = (path: string) => (view.kind === "browse" ? go({ kind: "browse", path }) : goPath(path));
  /** A course opens on its first tab (概览, unless that course's 概览 is hidden). */
  const openCourse = (c: Course) => go({ kind: "course", id: c.id, tab: viewOf(c.id, "overview"), path: c.dir, first: true });
  const launchTool = (x: ThingOf<"tool">) => {
    const key = thingKey(x);
    setOpening(key);
    api.launch(x.course, { tool_id: x.tool })
      .catch(fail(t("打开失败")))
      .finally(() => setOpening((k) => (k === key ? null : k)));
  };
  /** Anything, wherever it opens: a file in its app; a tool, a link, the course on Canvas in the
   * browser; a search as a smart folder; the rest in its course's page. Noted, with what had been
   * typed in search (`query`): what you open most and lately comes first there. */
  const open = (x: Thing, query = "") => {
    api.noteOpened(thingKey(x), query);
    if (x.type === "course") {
      const c = courseById(x.course);
      if (c) openCourse(c);
    } else if (x.type === "folder") goPath(x.path);
    else if (x.type === "file") void api.openPath(x.path).then(seenChanged, fail(t("打开失败")));
    else if (x.type === "link") void api.openExternal(x.url);
    else if (x.type === "tool") launchTool(x);
    else if (x.type === "search") go({ kind: "search", search: x });
    else if (isView(x, "canvas")) void api.openUrl(`/courses/${x.course}`);
    else if (cv && cv.id === x.course) go(toTab(cv, x));
    else if (courseById(x.course)) go({ kind: "course", id: x.course, tab: x, path: courseById(x.course)!.dir });
  };
  const openHere = (h: Hit) => {
    const x = thingOfHit(h);
    return x ? open(x) : void api.openHit(h);
  };
  const overview = useOverview(cv ? cv.id : null, version, seenTick);

  // The search window asks us to open something (a course's view, an announcement…), to show a
  // file in its folder, or to do something (sync, settings).
  const openLater = useRef(open);
  openLater.current = open;
  const goPathLater = useRef(goPath);
  goPathLater.current = goPath;
  const runLater = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    const offs = [
      listen<{ thing: Thing; query: string }>("open-thing", ({ payload }) => openLater.current(payload.thing, payload.query)),
      listen<{ path: string }>("show-path", ({ payload }) => goPathLater.current(parentOf(payload.path), payload.path)),
      listen<{ id: string }>("run-action", ({ payload }) => runLater.current(payload.id)),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()));
  }, []);
  // A saved search: shown as a smart folder, or as a course's tab.
  const searched = view.kind === "search" ? view.search : tab?.type === "search" ? tab : null;
  const folderEntry = view.kind === "search" ? pinned.find((p) => same(p, view.search)) : undefined; // (its name, if pinned)
  const scopeCourses = useMemo(() => {
    if (browsing === null) return [];
    return courseList.filter((c) => under(c.dir, browsing) || under(browsing, c.dir)).map((c) => c.id);
  }, [browsing, courseList]);

  // What the search box searches. In a course, what the tab shows: 公告 / 作业 / 页面 / 模块 / 成绩
  // narrow their own lists as you type, 文件 (or a folder tab) searches the folder you're in;
  // anything else, the course. Elsewhere, the folder you're in. "搜索整门课" widens it to the course.
  const filtering = !!tab && !wide && isView(tab) && tab.course === cv?.id && FILTERS_ITSELF.includes(tab.view);
  const folderScope = !wide && ((cv && filesTab) || (view.kind === "browse" && view.path !== "")) ? browsing : null;
  const courseWide = !!cv && !filesTab && !(isView(tab) && FILTERS_ITSELF.includes(tab.view));
  const tabName = tabEntry ? thingName(tabEntry, courseList, "tab") : "";
  const folderName = (path: string) => (course && path === course.dir ? VIEW_LABEL.files : path.split("/").pop() ?? path);
  useEffect(() => {
    if (!query.trim()) setWide(false);
  }, [query]);
  const searching = view.kind === "home" || (filesView && query.trim() !== "" && !filtering);
  const searchPlaceholder =
    cv && course
      ? wide || courseWide
        ? t("在 {label} 中搜索", { label: course.label })
        : filesTab
          ? t("在“{name}”中搜索", { name: folderName(cv.path) })
          : t("在{scope}中搜索", { scope: tabName })
      : view.kind === "browse" && view.path
        ? t("在“{name}”中搜索", { name: folderName(view.path) })
        : t("搜索");
  const results = useSearch(
    !query.trim() && searched ? thingKey(searched) : query,
    () => {
      if (!query.trim() && searched) {
        return api.search(searched.query, { courses: searched.courses, kinds: searched.kinds, namesOnly: !searched.content, limit: 500 });
      }
      if (!query.trim() || filtering || view.kind === "home") return Promise.resolve([]); // (搜索 finds its own: SearchHome)
      if (folderScope !== null) return api.search(query, { limit: 300, under: folderScope });
      if (browsing !== null && browsing !== "" && scopeCourses.length === 0) return Promise.resolve([]);
      return api.search(query, { limit: 300, courses: browsing ? scopeCourses : [] });
    },
    [view, searched && thingKey(searched), scopeCourses.join(","), version, folderScope, filtering],
  );
  /** Above the results: what was searched, and the way to search more (or less) widely. */
  const scopeNote = (() => {
    if (!query.trim()) return null;
    if (cv && course) {
      if (wide && !courseWide) {
        const narrow = filesTab ? folderName(cv.path) : tabName;
        return { text: t("在 {label} 中搜索", { label: course.label }), action: t("只搜“{name}” ›", { name: narrow }), onAction: () => setWide(false) };
      }
      if (folderScope !== null) {
        return { text: t("只搜“{name}”里的文件", { name: folderName(folderScope) }), action: t("搜索整门课 ›"), onAction: () => setWide(true) };
      }
    }
    if (view.kind === "browse" && folderScope !== null) {
      return { text: t("只搜“{name}”里的文件", { name: folderName(folderScope) }), action: t("搜索全部 ›"), onAction: () => setWide(true) };
    }
    return null;
  })();

  // -- actions --------------------------------------------------------------------------
  const signedOut = account !== null && !account.signed_in;
  /** What search can do (see Found.tsx): sync everything or a course, settings, a smart folder. */
  const runAction = (id: string) => {
    const c = id.startsWith("sync:") ? courseById(Number(id.slice(5))) : null;
    if (id === "sync") void startSync({}, t("全部课程"));
    else if (c) void startSync({ paths: [c.dir] }, c.label);
    else if (id === "settings") go({ kind: "settings" });
    else if (id === "smart-folder") setEditing({ folder: null });
  };
  runLater.current = runAction;
  /** Something search found: opened (↵), shown in its folder (⌘↵), or on Canvas (⌘⇧↵). */
  const openFound = (f: Found | undefined, how: How) => {
    if (!f) return;
    if (f.type === "action") {
      api.noteOpened(f.key, query);
      return runAction(f.action.id);
    }
    const path = f.type === "hit" ? f.hit.path : f.entry.type === "file" ? f.entry.path : null;
    if (how === "reveal" && path) return goPath(parentOf(path), path);
    if (f.type === "hit") {
      if (how === "canvas") return void api.openCanvas(f.hit);
      const x = thingOfHit(f.hit);
      return x ? open(x, query) : void api.openHit(f.hit);
    }
    if (how === "canvas") {
      const url = canvasUrl(f.entry);
      if (url) void api.openUrl(url).then(() => api.noteOpened(f.key, query));
      return;
    }
    open(thingOf(f.entry), query);
  };
  const startSync = async (scope: Scope, label: string) => {
    if (signedOut) return go({ kind: "settings" }); // sign in first
    setSyncLabel(label);
    try {
      setSync(await api.startSync(scope));
    } catch (e) {
      setSync({ phase: "failed", scope: [], running: false, errors: [String((e as Error).message)], warnings: [], total: 0, done: 0, current: "", changes: {}, finished_at: null });
    }
  };
  const syncBusy = !!sync?.running;
  const openMenu = (items: MenuItem[], x: number, y: number) => setMenu({ x, y, items });
  const reveal = (path: string) => void api.openPath(path, { reveal: true });

  const say = (message: string, action?: NoticeAction) => setNotice({ text: message, action });
  const fail = (what: string) => (e: unknown) => say(t("{what}：{why}", { what, why: friendly((e as Error).message) }));
  const undo = (run: () => void): NoticeAction => ({ label: t("撤销"), run });

  // -- places: 置顶, and the open course's tabs, overview and 工具与链接 ---------------------------
  /** 置顶 as it should be; `taken`: what was taken out, to say so (with 撤销). */
  const savePinned = (next: Shown[], taken?: string) => {
    const before = pinned;
    setPinned(next);
    api.arrangePinned(next).then(setPinned, fail(t("操作失败")));
    if (taken) say(taken, undo(() => savePinned(before)));
  };
  const nameOf = (x: Shown) => thingName(x, courseList);
  const isPinned = (x: Thing) => pinned.some((p) => same(p, x));
  /** Pinned (at a place in the list: dropped there; else at the end, said so). */
  const pinThing = (x: Shown, at?: number) => {
    if (isCollapsed("pinned")) toggle("pinned");
    savePinned(putAt(pinned, { ...x, hidden: false }, at ?? pinned.length));
    if (at === undefined) say(t("已置顶“{name}”", { name: nameOf(x) }));
  };
  const unpinThing = (x: Thing) => {
    const e = pinned.find((p) => same(p, x));
    if (!e) return;
    // A smart folder is only here: taken away, it's gone (撤销 brings it back).
    savePinned(without(pinned, x), e.type === "search" ? t("已删除智能文件夹“{name}”", { name: nameOf(e) }) : t("已取消置顶“{name}”", { name: nameOf(e) }));
    if (view.kind === "search" && same(view.search, x)) go({ kind: "home" });
  };
  /** One of the open course's places as it should be. */
  const arrangeLayout = (place: Place, next: Shown[]) => {
    if (!courseLayout || layoutId === null) return;
    const id = layoutId;
    keepLayout(id, { ...courseLayout, [place]: next });
    api.arrangeCourse(id, place, next).then((l) => keepLayout(id, l), fail(t("操作失败")));
    // The tab you're on, just hidden or taken away: to the first one.
    if (place === "tabs" && cv && listed(courseLayout.tabs, cv.tab) && !listed(next, cv.tab)) replaceView(toTab(cv, firstTab(next, id)));
  };
  const layoutDone = (id: number, message: string) => (l: CourseLayout) => {
    keepLayout(id, l);
    say(message);
  };
  /** Back to the default, one place after another (each writes config.toml). */
  const resetLayout = async (places: Place[]) => {
    if (layoutId === null) return;
    const id = layoutId;
    try {
      let l: CourseLayout | null = null;
      for (const place of places) l = await api.resetCourseLayout(id, place);
      if (l) layoutDone(id, places.includes("tabs") ? t("这门课的标签恢复了默认") : t("这门课的概览恢复了默认，添加的卡片还在"))(l);
    } catch (e) {
      fail(t("操作失败"))(e);
    }
  };
  const makeDefaultLayout = (place: Place) =>
    layoutId !== null && api.makeDefaultLayout(layoutId, place).then(layoutDone(layoutId, t("其他没单独排过的课程现在也这样排")), fail(t("操作失败")));

  /** What can be done with a thing, besides putting it places (they add that). */
  const ways = (x: Thing): MenuItem[] => {
    const openIt: MenuItem = { label: t("打开"), onSelect: () => open(x) };
    switch (x.type) {
      case "course":
        return courseById(x.course) ? [
          openIt,
          { label: t("在 Canvas 中打开"), onSelect: () => void api.openUrl(`/courses/${x.course}`) },
          { label: t("在 {app} 中显示课程文件", { app: fileManager }), onSelect: () => reveal(courseById(x.course)!.dir) },
        ] : [];
      case "folder":
        return [openIt, { label: t("在 {app} 中显示", { app: fileManager }), onSelect: () => reveal(x.path) }];
      case "file":
        return [
          openIt,
          ...(isMac ? [{ label: t("快速预览"), onSelect: () => void api.openPath(x.path, { preview: true }) }] : []),
          { label: t("在文件夹中显示"), onSelect: () => goPath(parentOf(x.path), x.path) },
          { label: t("在 {app} 中显示", { app: fileManager }), onSelect: () => reveal(x.path) },
        ];
      case "doc": {
        const where = { page: "pages", assignment: "assignments", announcement: "discussion_topics" }[x.kind];
        return [openIt, { label: t("在 Canvas 中打开"), onSelect: () => void api.openUrl(`/courses/${x.course}/${where}/${encodeURIComponent(x.id)}`) }];
      }
      default:
        return [openIt];
    }
  };
  const things: Things = {
    courses: courseList, open, opening, ways, isPinned,
    showInFolder: (path) => goPath(parentOf(path), path),
    pin: (x) => pinThing(x),
    unpin: unpinThing,
    menu: openMenu,
  };
  const pinOf = (x: Shown): MenuItem => pinItem(things, x);
  const moveItems = (x: Shown): MenuItem[] => {
    const i = pinned.findIndex((p) => same(p, x));
    return [
      { label: t("上移"), disabled: i <= 0, onSelect: () => savePinned(moved(pinned, i, i - 1)) },
      { label: t("下移"), disabled: i >= pinned.length - 1, onSelect: () => savePinned(moved(pinned, i, i + 1)) },
    ];
  };

  /** Rename a folder, then follow it: any open view inside it moves to the new path. */
  const renameFolder = async (path: string, name: string) => {
    setRenaming(null);
    setRenameDialog(null);
    try {
      const { path: renamed } = await api.rename(path, name);
      const move = (p: string) => (under(p, path) ? renamed + p.slice(path.length) : p);
      const moveThing = (x: Thing): Thing => (x.type === "folder" || x.type === "file" ? { ...x, path: move(x.path) } : x);
      setHist((h) => ({
        ...h,
        stack: h.stack.map((v) => (v.kind === "browse" ? { ...v, path: move(v.path), select: v.select && move(v.select) }
          : v.kind === "course" ? { ...v, tab: moveThing(v.tab), path: move(v.path), select: v.select && move(v.select) } : v)),
      }));
      setHist((h) => {
        const cur = h.stack[h.i];
        if ((cur.kind !== "browse" && cur.kind !== "course") || cur.path !== parentOf(renamed)) return h;
        const stack = [...h.stack];
        stack[h.i] = { ...cur, select: renamed }; // keep the renamed folder selected
        return { ...h, stack };
      });
      refresh();
    } catch (e) {
      fail(t("重命名失败"))(e);
    }
  };

  const askDelete = (paths: string[], names: string[]) => paths.length > 0 && setDeleting({ paths, label: countLabel(names) });
  const untrack = (paths: string[], names: string[]) =>
    api.untrack(paths).then(() => {
      say(t("已停止同步 {what}：文件留在原处，现在是你自己的了", { what: countLabel(names) }));
      refresh();
    }, fail(t("停止同步失败")));
  const track = (paths: string[], names: string[]) =>
    api.track(paths).then(() => {
      say(t("已恢复同步 {what}，下次同步时会更新", { what: countLabel(names) }));
      refresh();
    }, fail(t("恢复同步失败")));
  const deleteItem = (e: Entry): MenuItem => ({
    label: t("移到{trash}…", { trash: trashName }), hint: shortcut.delete, danger: true, disabled: syncBusy, onSelect: () => askDelete([e.path], [e.name]),
  });
  const restoreScope = (e: Entry): Scope => (e.type === "dir" ? { paths: [e.path] } : { file_ids: [e.file_id!] });

  const entryMenu = (e: Entry): MenuItem[] => {
    if (e.deleted) {
      return [
        { label: t("恢复…"), onSelect: () => setRestoring({ scope: restoreScope(e), label: e.name }) },
        ...(e.url ? [{ label: t("在 Canvas 中打开"), onSelect: () => void api.openUrl(e.url!) }] : []),
      ];
    }
    if (e.type === "dir") {
      return [
        { label: t("打开"), hint: shortcut.open, onSelect: () => goFolder(e.path) },
        { label: t("在 {app} 中显示", { app: fileManager }), onSelect: () => reveal(e.path) },
        "separator",
        pinOf(thingOfEntry(e, courseList)), // (a course's own folder, seen in 全部文件: the course)
        { label: t("重命名…"), hint: shortcut.rename, disabled: syncBusy, onSelect: () => setRenaming(e.path) },
        "separator",
        { label: t("从 Canvas 同步此文件夹"), disabled: syncBusy || e.skipped, onSelect: () => startSync({ paths: [e.path] }, e.name) },
        { label: t("恢复此文件夹的原版…"), disabled: !e.changes, onSelect: () => setRestoring({ scope: { paths: [e.path] }, label: e.name }) },
        e.skipped
          ? { label: t("恢复同步此文件夹"), disabled: syncBusy, onSelect: () => void track([e.path], [e.name]) }
          : { label: t("停止同步此文件夹（保留文件）"), disabled: syncBusy, onSelect: () => void untrack([e.path], [e.name]) },
        "separator",
        deleteItem(e),
      ];
    }
    const items: MenuItem[] = [
      { label: t("打开"), hint: shortcut.open, onSelect: () => void api.openPath(e.path) },
      ...(isMac ? [{ label: t("快速预览"), hint: shortcut.preview, onSelect: () => void api.openPath(e.path, { preview: true }) }] : []),
      { label: t("在 {app} 中显示", { app: fileManager }), onSelect: () => reveal(e.path) },
    ];
    if (e.url) items.push({ label: t("在 Canvas 中打开"), onSelect: () => void api.openUrl(e.url!) });
    if (e.link) items.push({ label: t("显示原始文件"), onSelect: () => goPath(parentOf(e.link!), e.link!) });
    items.push("separator", pinOf({ type: "file", path: e.path }));
    if (e.states.includes("untracked")) {
      items.push("separator", { label: t("恢复同步"), disabled: syncBusy, onSelect: () => void track([e.path], [e.name]) });
    } else if (e.file_id !== null) {
      items.push(
        "separator",
        { label: t("从 Canvas 同步"), disabled: syncBusy, onSelect: () => startSync({ file_ids: [e.file_id!] }, e.name) },
        { label: t("恢复 Canvas 原版…"), disabled: !e.states.includes("modified"), onSelect: () => setRestoring({ scope: { file_ids: [e.file_id!] }, label: e.name }) },
        { label: t("停止同步（保留文件）"), disabled: syncBusy, onSelect: () => void untrack([e.path], [e.name]) },
      );
    }
    items.push("separator", deleteItem(e));
    return items;
  };

  /** Right-clicking a selection of several. */
  /** The folder showing, right-clicked where nothing is: what's shown, and what to do with it. */
  const folderMenu = (here: string): MenuItem[] => {
    const label = course && here === course.dir ? course.label : here ? here.split("/").pop()! : t("全部文件");
    return sections(
      [{ label: t("显示改动"), checked: showChanges, hint: shortcut.toggleChanges || undefined, onSelect: () => setShowChanges(!showChanges) }],
      [
        { label: t("从 Canvas 同步此文件夹"), disabled: syncBusy, onSelect: () => (here ? startSync({ paths: [here] }, label) : startSync({}, t("全部课程"))) },
        { label: t("恢复此文件夹的原版…"), onSelect: () => setRestoring({ scope: { paths: [here] }, label }) },
        { label: t("在 {app} 中显示", { app: fileManager }), onSelect: () => void api.openPath(here, { reveal: here !== "" }) },
      ],
      course ? [{ label: t("在 Canvas 中打开这门课"), onSelect: () => void api.openUrl(`/courses/${course.id}`) }] : [],
    );
  };
  const entriesMenu = (es: Entry[]): MenuItem[] => {
    if (es.length === 1) return entryMenu(es[0]);
    const live = es.filter((e) => !e.deleted);
    const files = live.filter((e) => e.type === "file");
    const synced = live.filter((e) => e.type === "dir" || e.file_id !== null);
    const label = countLabel(es.map((e) => e.name));
    const scope: Scope = {
      paths: es.filter((e) => e.type === "dir").map((e) => e.path),
      file_ids: es.filter((e) => e.type === "file" && e.file_id !== null).map((e) => e.file_id!),
    };
    return [
      { label: t("打开 {n} 个文件", { n: files.length }), disabled: !files.length, onSelect: () => files.slice(0, 20).forEach((f) => void api.openPath(f.path)) },
      "separator",
      { label: t("从 Canvas 同步"), disabled: syncBusy || !synced.length, onSelect: () => startSync(scope, label) },
      { label: t("恢复原版…"), onSelect: () => setRestoring({ scope, label }) },
      { label: t("停止同步（保留文件）"), disabled: syncBusy || !synced.length, onSelect: () => void untrack(synced.map((e) => e.path), synced.map((e) => e.name)) },
      "separator",
      {
        label: t("把 {what} 移到{trash}…", { what: countLabel(live.map((e) => e.name)), trash: trashName }), hint: shortcut.delete, danger: true, disabled: syncBusy || !live.length,
        onSelect: () => askDelete(live.map((e) => e.path), live.map((e) => e.name)),
      },
    ];
  };

  const hitsMenu = (hs: Hit[]): MenuItem[] => {
    const onDisk = hs.filter((h) => h.path);
    const del: MenuItem = {
      label: hs.length > 1 ? t("把 {n} 个文件移到{trash}…", { n: onDisk.length, trash: trashName }) : t("移到{trash}…", { trash: trashName }), hint: shortcut.delete, danger: true, disabled: syncBusy || !onDisk.length,
      onSelect: () => askDelete(onDisk.map((h) => h.path!), onDisk.map((h) => h.title)),
    };
    if (hs.length > 1) {
      return [{ label: t("打开 {n} 项", { n: hs.length }), onSelect: () => hs.slice(0, 20).forEach(openHere) }, "separator", del];
    }
    const h = hs[0];
    const x = thingOfHit(h);
    return [
      { label: t("打开"), hint: shortcut.open, onSelect: () => openHere(h) },
      ...(h.path && isMac ? [{ label: t("快速预览"), hint: shortcut.preview, onSelect: () => void api.openPath(h.path!, { preview: true }) }] : []),
      ...(h.path
        ? [
            { label: t("在文件夹中显示"), onSelect: () => goPath(parentOf(h.path!), h.path!) },
            { label: t("在 {app} 中显示", { app: fileManager }), onSelect: () => reveal(h.path!) },
          ]
        : []),
      ...(h.url ? [{ label: t("在 Canvas 中打开"), onSelect: () => void api.openUrl(h.url!) }] : []),
      ...(x ? ["separator" as const, pinOf({ ...x, name: h.title })] : []),
      ...(h.path ? ["separator" as const, del] : []),
    ];
  };

  const unhide = (c: Course) =>
    api.hideCourse(c.id, false, c.excluded ? true : undefined).then(() => {
      say(c.excluded ? t("“{name}”回来了，下次同步时会更新", { name: c.label }) : t("“{name}”回来了", { name: c.label }));
      refresh();
    }, fail(t("操作失败")));
  /** A hidden term back, synced again: its courses each as they were before hiding. */
  const unhideTerm = (term: string, list: Course[]) =>
    api.hideCourses(list.map((c) => c.id), false, list.some((c) => c.excluded) ? true : undefined).then(() => {
      say(t("“{name}”回来了", { name: term }));
      refresh();
    }, fail(t("操作失败")));
  const hiddenCourseMenu = (c: Course): MenuItem[] => [
    { label: t("打开"), onSelect: () => openCourse(c) },
    { label: t("在 Canvas 中打开"), onSelect: () => void api.openUrl(`/courses/${c.id}`) },
    "separator",
    { label: c.excluded ? t("取消隐藏并恢复同步") : t("取消隐藏"), onSelect: () => void unhide(c) },
  ];
  const courseMenu = (c: Course): MenuItem[] => [
    { label: t("打开"), onSelect: () => openCourse(c) },
    { label: t("查看文件"), onSelect: () => go({ kind: "course", id: c.id, tab: viewOf(c.id, "files"), path: c.dir }) },
    { label: t("在 Canvas 中打开"), onSelect: () => void api.openUrl(`/courses/${c.id}`) },
    { label: t("在 {app} 中显示课程文件", { app: fileManager }), onSelect: () => reveal(c.dir) },
    "separator",
    { label: t("从 Canvas 同步此课程"), disabled: syncBusy, onSelect: () => startSync({ paths: [c.dir] }, c.label) },
    { label: t("恢复此课程的原版…"), disabled: !changes[c.id], onSelect: () => setRestoring({ scope: { paths: [c.dir] }, label: c.label }) },
    "separator",
    pinOf({ type: "course", course: c.id }),
    {
      label: t("重命名课程…"), disabled: syncBusy,
      onSelect: () => setRenameDialog({ path: c.dir, title: t("重命名课程"), current: c.label, hint: t("只改在这里显示的名字，同步不受影响。") }),
    },
    ...(c.renamed ? [{ label: t("恢复原名（{name}）", { name: c.default_name }), disabled: syncBusy, onSelect: () => void renameFolder(c.dir, c.default_name) }] : []),
    { label: t("更换图标…"), onSelect: () => setChoosingIcon(c) },
    "separator",
    { label: t("新建智能文件夹（限此课程）…"), onSelect: () => setEditing({ folder: null, preset: { courses: [c.id] } }) },
    "separator",
    { label: t("隐藏此课程…"), onSelect: () => setHiding({ courses: [c] }) },
  ];

  const termMenu = (term: string, list: Course[]): MenuItem[] => {
    // The term's own folder, if its courses share one (they do with the default layout).
    const parents = [...new Set(list.map((c) => parentOf(c.dir)))];
    const termDir = parents.length === 1 && parents[0] ? parents[0] : null;
    return [
      { label: t("从 Canvas 同步 {term}", { term }), disabled: syncBusy, onSelect: () => startSync({ paths: list.map((c) => c.dir) }, term) },
      { label: t("恢复 {term} 的原版…", { term }), disabled: !list.some((c) => changes[c.id]), onSelect: () => setRestoring({ scope: { paths: list.map((c) => c.dir) }, label: term }) },
      ...(termDir
        ? [
            "separator" as const,
            {
              label: t("重命名学期…"), disabled: syncBusy,
              onSelect: () => setRenameDialog({ path: termDir, title: t("重命名学期"), current: term, hint: t("只改在这里显示的名字，同步不受影响。") }),
            },
            ...(list[0].term && list[0].term !== term
              ? [{ label: t("恢复原名（{name}）", { name: list[0].term! }), disabled: syncBusy, onSelect: () => void renameFolder(termDir, list[0].term!) }]
              : []),
          ]
        : []),
      "separator",
      { label: t("隐藏此学期…"), onSelect: () => setHiding({ courses: list, term }) },
    ];
  };

  /** Something pinned: what can be done with it, then renaming, moving and unpinning it. (A course
   * has its own menu; a smart folder is edited, and deleted when unpinned.) */
  const pinnedMenu = (x: Shown): MenuItem[] => {
    const c = x.type === "course" ? courseById(x.course) : null;
    if (c) return sections(courseMenu(c), moveItems(x));
    return sections(
      x.exists === false ? [] : ways(x),
      x.type === "search" ? [{ label: t("编辑…"), onSelect: () => setEditing({ folder: { ...x, title: x.title ?? "" } }) }] : [],
      [
        { label: t("重命名…"), onSelect: () => setRenamingPin(x) },
        ...(x.title && x.type !== "search" ? [{ label: t("恢复原名（{name}）", { name: ownName(x, courseList) }), onSelect: () => savePinned(changed(pinned, x, { title: "" })) }] : []),
      ],
      moveItems(x),
      [x.type === "search"
        ? { label: t("删除智能文件夹"), danger: true, onSelect: () => unpinThing(x) }
        : { label: t("取消置顶"), onSelect: () => unpinThing(x) }],
    );
  };

  /** What's showing here, as a thing: to pin it from 置顶's +. */
  const shownThing: Shown | null = cv && course
    ? filesTab ? (cv.path === course.dir ? { type: "course", course: course.id } : { type: "folder", path: cv.path })
      : isView(tab, "overview") ? { type: "course", course: course.id } : tabEntry
    : view.kind === "browse" && view.path ? { type: "folder", path: view.path } : null;
  const addMenu = (): MenuItem[] => [
    { label: t("新建智能文件夹…"), onSelect: () => setEditing({ folder: null }) },
    ...(shownThing && !isPinned(shownThing)
      ? [{ label: t("置顶“{name}”", { name: shownThing.type === "folder" ? shownThing.path.split("/").pop()! : nameOf(shownThing) }), onSelect: () => pinThing(shownThing) }]
      : []),
  ];

  // -- arranging the sidebar: drag pinned items, courses within a term, terms; fold sections -----
  const groups = useMemo(() => arrange(courseList.filter((c) => !c.hidden), order), [courseList, order]);
  const hiddenCourses = courseList.filter((c) => c.hidden);
  const saveOrder = (next: Partial<SidebarOrder>) => {
    setOrder((o) => ({ ...o, ...next }));
    api.arrangeSidebar(next).then(setOrder, fail(t("移动失败")));
  };
  const termDrag = useReorder(groups.length, (from, to) => saveOrder({ terms: moved(groups.map((g) => g.key), from, to) }));
  /** One term's courses in a new order; every course gets its place, so the rest stay put. */
  const reorderTerm = (key: string, ids: number[]) =>
    saveOrder({ courses: groups.flatMap((g) => (g.key === key ? ids : g.courses.map((c) => c.id))) });
  const isCollapsed = (section: string) => collapsed.includes(section);
  const toggle = (section: string) => setCollapsed(isCollapsed(section) ? collapsed.filter((s) => s !== section) : [...collapsed, section]);

  if (startupError) return <StartupError message={startupError} />;

  // -- layout ---------------------------------------------------------------------------
  /** Whether a thing is what's on screen: a course's tab, the announcement or page being read,
   * the module open in 模块, the folder 文件 is in, the smart folder. */
  const showing = (x: Thing): boolean => {
    if (view.kind === "search") return same(x, view.search);
    if (x.type === "folder") return folderShown === x.path;
    if (!cv || !tab) return false;
    if (same(x, tab)) return true;
    if (x.type === "doc") return x.course === cv.id && isView(tab, KIND_VIEW[x.kind]) && cv.item === x.id;
    if (x.type === "module") return x.course === cv.id && isView(tab, "modules") && cv.item === String(x.module);
    return false;
  };
  const pinnedHere = pinned.some(showing); // highlight that, not also its course
  const renderPinned = (x: Shown) => {
    const c = x.type === "course" ? courseById(x.course) : null;
    const inCourse = x.in_course != null ? courseById(x.in_course)
      : "course" in x ? courseById(x.course) : x.type === "folder" || x.type === "file" ? courseAt(x.path) : null; // (just pinned)
    const gone = x.exists === false;
    const where = x.type === "course" ? (c ? (c.term_label ?? undefined) : t("找不到这门课了"))
      : x.type === "folder" ? (gone ? t("找不到这个文件夹了") : pinnedWhere(x.path, inCourse))
        : x.type === "file" ? (gone ? t("找不到这个文件了") : pinnedWhere(x.path, inCourse))
          : x.type === "link" ? ownName({ ...x, title: "" }, courseList)
            : x.type === "search" ? undefined
              : opening === thingKey(x) ? t("正在打开…") : gone ? t("Canvas 上已经没有了") : inCourse?.label ?? t("找不到这门课了");
    return (
      <NavItem
        icon={<ThingIcon thing={x} courses={courseList} />}
        title={nameOf(x)}
        subtitle={where}
        count={c?.new}
        muted={gone}
        active={x.type === "course" ? course?.id === x.course && !pinnedHere : showing(x)}
        onClick={() => !gone && open(x)}
        onMenu={(mx, my) => openMenu(pinnedMenu(x), mx, my)}
      />
    );
  };

  /** What the open course's page shows, as its tab has it. */
  const coursePage = (cv: CourseView, course: Course, tab: Thing) => {
    if (isView(tab, "overview")) {
      return (
        <CourseOverview
          key={course.id} // (each course's cards are placed afresh, not slid from the last course's places)
          course={course}
          overview={overview}
          cards={courseLayout?.overview ?? null}
          links={courseLayout?.links ?? []}
          own={!!courseLayout && (courseLayout.own.overview || courseLayout.own.links)}
          onArrange={arrangeLayout}
          onReset={() => void resetLayout(["overview", "links"])}
          onMakeDefault={() => void makeDefaultLayout("overview")}
          onSay={say}
          onMarkSeen={(kinds) => void api.markSeen(course.id, kinds).then(refresh, fail(t("标记失败")))}
        />
      );
    }
    if (isView(tab, "modules") || tab.type === "module") {
      return (
        <CourseModules
          key={`${course.id}:${thingKey(tab)}`}
          course={course}
          version={version}
          focus={cv.item ? Number(cv.item) : undefined}
          only={tab.type === "module" ? tab.module : undefined}
          query={filtering ? query : ""}
          onWiden={() => setWide(true)}
        />
      );
    }
    if (isView(tab, "grades")) {
      return <CourseGrades key={course.id} course={course} version={version} query={filtering ? query : ""} onWiden={() => setWide(true)} />;
    }
    if (isView(tab, "tools")) {
      return (
        <LinksPage course={course} links={courseLayout?.links ?? []} syllabus={!!overview?.counts.syllabus}
          onArrange={(next) => arrangeLayout("links", next)} onSay={say} />
      );
    }
    if (isView(tab) && VIEW_KIND[tab.view]) {
      return (
        <CourseReader
          course={course}
          kind={VIEW_KIND[tab.view]!}
          selected={cv.item ?? null}
          version={version}
          onSelect={(id) => replaceView({ ...cv, item: id })}
          onSeen={seenChanged}
          query={filtering ? query : ""}
          onWiden={() => setWide(true)}
        />
      );
    }
    if (tab.type === "doc") return <CourseDoc course={course} kind={tab.kind} id={tab.id} version={version} onSeen={seenChanged} />;
    if (tab.type === "note") return <NoteEditor key={thingKey(tab)} course={course.id} id={tab.id} page />;
    if (tab.type === "search") return null; // (its results: below)
    return (
      <FileBrowser
        path={cv.path}
        root={course.dir}
        select={cv.select}
        version={version}
        mode={mode}
        showChanges={showChanges}
        onNavigate={goPath}
        onOpen={(e) => (e.deleted ? setRestoring({ scope: restoreScope(e), label: e.name }) : void api.openPath(e.path).then(seenChanged))}
        onPreview={(e) => void api.openPath(e.path, { preview: true })}
        onMenu={(es, x, y) => openMenu(entriesMenu(es), x, y)}
        onFolderMenu={(x, y) => openMenu(folderMenu(cv.path), x, y)}
        onDelete={(es) => {
          const live = es.filter((e) => !e.deleted);
          if (!syncBusy) askDelete(live.map((e) => e.path), live.map((e) => e.name));
        }}
        renaming={renaming}
        onStartRename={(e) => canRename(e) && !syncBusy && setRenaming(e.path)}
        onRename={(e, name) => void renameFolder(e.path, name)}
        onRenameCancel={() => setRenaming(null)}
      />
    );
  };
  const page = cv && course && tab && !searching ? coursePage(cv, course, tab) : null;

  return (
    <ThingsContext.Provider value={things}>
    <div className="flex h-screen bg-bg text-fg">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-sidebar">
        {/* The title bar: the window controls (macOS), then the sync button. Empty space drags the window. */}
        <div data-tauri-drag-region="deep" className={`flex h-13 shrink-0 items-center justify-end pr-3 ${trafficLights ? "pl-20" : "pl-4"}`}>
          <button
            onClick={() => startSync({}, t("全部课程"))}
            disabled={syncBusy}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-soft hover:bg-chip disabled:opacity-60"
            title={t("从 Canvas 拉取所有课程的新文件")}
          >
            <RefreshCw className={`size-3.5 ${syncBusy ? "animate-spin" : ""}`} aria-hidden />
            {t("同步")}
          </button>
        </div>
        {signedOut ? (
          <button onClick={() => go({ kind: "settings" })} className="mx-4 mb-2 rounded-md bg-warn-soft px-2.5 py-2 text-left text-xs text-warn hover:opacity-90">
            {t("还没有登录 Canvas，不能同步。点这里登录。")}
          </button>
        ) : (
          <SyncStatus sync={sync} label={syncLabel} onFix={() => go({ kind: "settings" })} />
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <NavItem icon={<Search className="size-4" />} active={view.kind === "home"} onClick={() => go({ kind: "home" })} title={t("搜索")} />
          <NavItem icon={<FolderTree className="size-4" />} active={view.kind === "browse" && view.path === ""} onClick={() => go({ kind: "browse", path: "" })} title={t("全部文件")} />

          <PinnedSection
            items={pinned}
            collapsed={isCollapsed("pinned")}
            header={
              <SectionHeader
                title={t("置顶@@heading")}
                collapsed={isCollapsed("pinned")}
                onToggle={() => toggle("pinned")}
                action={{ label: t("添加到置顶"), icon: <Plus className="size-3.5" />, onClick: (x, y) => openMenu(addMenu(), x, y) }}
              />
            }
            empty={
              <p className="px-2 py-1 text-xs leading-relaxed text-muted">
                {t("把课程、文件夹、文件、公告、页面、工具、标签拖到这里，或者右键选“置顶”。点 + 新建智能文件夹（保存的搜索）。")}
              </p>
            }
            render={renderPinned}
            onMove={(from, to) => savePinned(moved(pinned, from, to))}
            onPin={(x, at) => pinThing(x, at)}
            onUnpin={(x) => unpinThing(x)}
          />

          {courseList.length === 0 && !signedOut && (
            <p className="px-2 py-3 text-xs leading-relaxed text-muted">{sync?.running ? t("正在第一次同步，课程马上就会出现在这里。") : t("还没有课程。点上面的“同步”从 Canvas 拉取。")}</p>
          )}
          {groups.map((g, i) => (
            <TermSection
              key={g.key}
              group={g}
              sectionRef={termDrag.ref(i)}
              grab={termDrag.handle(i)}
              collapsed={isCollapsed(`term:${g.key}`)}
              onToggle={() => toggle(`term:${g.key}`)}
              onMenu={(x, y) => openMenu(termMenu(g.label, g.courses), x, y)}
              onReorder={(ids) => reorderTerm(g.key, ids)}
              renderCourse={(c) => (
                <NavItem
                  icon={<CourseIcon course={c} />}
                  title={c.label}
                  subtitle={c.renamed ? c.display_code : c.name !== c.display_code ? c.name : undefined}
                  active={course?.id === c.id && !pinnedHere && !isPinned({ type: "course", course: c.id })}
                  count={c.new}
                  onClick={() => openCourse(c)}
                  onMenu={(x, y) => openMenu(courseMenu(c), x, y)}
                />
              )}
            />
          ))}

          {hiddenCourses.length > 0 && (
            <>
              <SectionHeader
                title={t("已隐藏的课程")}
                collapsed={!hiddenOpen}
                onToggle={() => setHiddenOpen(!hiddenOpen)}
              />
              {hiddenOpen && groupByTerm(hiddenCourses).map(([term, list]) => (
                <div key={term}>
                  <p
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu([{ label: t("取消隐藏整个学期"), onSelect: () => void unhideTerm(term, list) }], e.clientX, e.clientY);
                    }}
                    className="px-2 pt-1.5 pb-0.5 text-[11px] text-muted"
                  >
                    {term}
                  </p>
                  {list.map((c) => (
                    <NavItem
                      key={c.id}
                      icon={<CourseIcon course={c} />}
                      title={c.label}
                      subtitle={c.excluded ? t("不再同步") : undefined}
                      muted
                      active={course?.id === c.id}
                      onClick={() => openCourse(c)}
                      onMenu={(x, y) => openMenu(hiddenCourseMenu(c), x, y)}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
        </nav>
        <div className="border-t border-line px-2 py-2">
          <NavItem icon={<SettingsIcon className="size-4" />} active={view.kind === "settings"} onClick={() => go({ kind: "settings" })} title={t("设置")} />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region="deep" className="flex h-13 shrink-0 items-center gap-2 border-b border-line px-4">
          <div className="flex shrink-0">
            <ToolButton title={t("后退 ({back})", { back: shortcut.back })} disabled={hist.i === 0} onClick={() => step(-1)}><ChevronLeft className="size-4" /></ToolButton>
            <ToolButton title={t("前进 ({forward})", { forward: shortcut.forward })} disabled={hist.i === hist.stack.length - 1} onClick={() => step(1)}><ChevronRight className="size-4" /></ToolButton>
          </div>
          <div className="min-w-0 flex-1">
            {view.kind === "browse" && <Breadcrumb path={view.path} onGo={goFolder} />}
            {cv && course && (
              <Breadcrumb
                path={filesTab ? cv.path : course.dir}
                root={{ path: course.dir, label: course.label, icon: <CourseIcon course={course} /> }}
                onGo={(p) => (p === course.dir && !filesTab ? openCourse(course) : goPath(p))}
              />
            )}
            {view.kind === "search" && <SmartTitle folder={view.search} name={folderEntry ? nameOf(folderEntry) : nameOf(view.search)} courses={courseList} />}
            {view.kind === "home" && <span className="text-sm font-medium">{t("搜索所有课程")}</span>}
            {view.kind === "settings" && <span className="text-sm font-medium">{t("设置")}</span>}
          </div>
          {view.kind !== "home" && view.kind !== "settings" && (
            <>
              {filesView && (
                <SearchInput inputRef={searchBox} value={query} onChange={setQuery} placeholder={searchPlaceholder} compact />
              )}
              {(filesTab || !!searched || searching) && (
                <div className="flex shrink-0 rounded-md border border-line p-0.5">
                  <ToolButton title={t("列表")} pressed={mode === "list"} onClick={() => setMode("list")}><List className="size-4" /></ToolButton>
                  <ToolButton title={t("图标")} pressed={mode === "grid"} onClick={() => setMode("grid")}><LayoutGrid className="size-4" /></ToolButton>
                </div>
              )}
              {view.kind === "search" && folderEntry && (
                <Button onClick={() => setEditing({ folder: { ...view.search, title: folderEntry.title ?? "" } })} className="shrink-0 text-xs">{t("编辑")}</Button>
              )}
            </>
          )}
        </header>

        {cv && course && tab && (
          <CourseTabs
            course={course}
            tab={tab}
            overview={overview}
            entries={courseLayout ? tabs : null}
            own={!!courseLayout?.own.tabs}
            onArrange={(next) => arrangeLayout("tabs", next)}
            onReset={() => void resetLayout(["tabs"])}
            onMakeDefault={() => void makeDefaultLayout("tabs")}
            onTab={(x) => go(toTab(cv, x))}
            onSay={say}
            onMarkAllSeen={() => void api.markSeen(course.id).then(refresh, fail(t("标记失败")))}
          />
        )}

        {view.kind === "home" ? (
          <SearchHome
            input={<SearchInput inputRef={searchBox} value={query} onChange={setQuery} placeholder={t("搜索所有课程… 例如 221 mt")} autoFocus />}
            query={query}
            onQuery={setQuery}
            version={version}
            courses={courseList}
            onOpen={openFound}
            props={(f) => (f.type === "hit" ? { onContextMenu: (ev: React.MouseEvent) => (ev.preventDefault(), openMenu(hitsMenu([f.hit]), ev.clientX, ev.clientY)) } : {})}
          />
        ) : view.kind === "settings" ? (
          <Settings
            sync={sync}
            onSync={() => void startSync({}, t("全部课程"))}
            onAccount={(a) => (setAccount(a), refresh())}
            onShowFiles={() => go({ kind: "browse", path: "" })}
          />
        ) : page ? (
          page
        ) : view.kind === "browse" && !searching ? (
          <FileBrowser
            path={view.path}
            root=""
            select={view.select}
            version={version}
            mode={mode}
            showChanges={showChanges}
            onNavigate={goFolder}
            onOpen={(e) => (e.deleted ? setRestoring({ scope: restoreScope(e), label: e.name }) : void api.openPath(e.path).then(seenChanged))}
            onPreview={(e) => void api.openPath(e.path, { preview: true })}
            onMenu={(es, x, y) => openMenu(entriesMenu(es), x, y)}
            onFolderMenu={(x, y) => openMenu(folderMenu(view.path), x, y)}
            onDelete={(es) => {
              const live = es.filter((e) => !e.deleted);
              if (!syncBusy) askDelete(live.map((e) => e.path), live.map((e) => e.name));
            }}
            renaming={renaming}
            onStartRename={(e) => canRename(e) && !syncBusy && setRenaming(e.path)}
            onRename={(e, name) => void renameFolder(e.path, name)}
            onRenameCancel={() => setRenaming(null)}
          />
        ) : (
          <Results
            view={view}
            mode={mode}
            query={query}
            results={results}
            asked={!!searched || query.trim() !== ""}
            scope={scopeNote}
            showCourse={!course}
            onOpen={openHere}
            onReveal={(h) => h.path && goPath(parentOf(h.path), h.path)}
            onMenu={(hs, x, y) => openMenu(hitsMenu(hs), x, y)}
            onDelete={(hs) => !syncBusy && askDelete(hs.map((h) => h.path!), hs.map((h) => h.title))}
          />
        )}
      </main>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {renameDialog && (
        <RenameDialog
          current={renameDialog.current}
          title={renameDialog.title}
          hint={renameDialog.hint}
          onClose={() => setRenameDialog(null)}
          onSubmit={(name) => void renameFolder(renameDialog.path, name)}
        />
      )}
      {renamingPin && (
        <RenameDialog
          current={nameOf(renamingPin)}
          title={t("重命名")}
          hint={t("只改在置顶里显示的名字。")}
          onClose={() => setRenamingPin(null)}
          onSubmit={(title) => {
            savePinned(changed(pinned, renamingPin, { title }));
            setRenamingPin(null);
          }}
        />
      )}
      <Notice notice={notice} onDone={() => setNotice(null)} />
      {choosingIcon && (
        <CourseIconDialog
          course={choosingIcon}
          onClose={() => setChoosingIcon(null)}
          onDone={() => {
            setChoosingIcon(null);
            refresh();
          }}
        />
      )}
      {hiding && (
        <HideCourseDialog
          courses={hiding.courses}
          term={hiding.term}
          onClose={() => setHiding(null)}
          onDone={() => {
            say(t("已隐藏“{name}”", { name: hiding.term ?? hiding.courses[0].label }));
            if (cv && hiding.courses.some((c) => c.id === cv.id)) go({ kind: "home" });
            setHiding(null);
            refresh();
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          paths={deleting.paths}
          label={deleting.label}
          onClose={() => setDeleting(null)}
          onDone={() => {
            say(t("已移到{trash}：{label}", { trash: trashName, label: deleting.label }));
            setDeleting(null);
            refresh();
          }}
        />
      )}
      {restoring && (
        <RestoreDialog
          scope={restoring.scope}
          label={restoring.label}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setRestoring(null);
            refresh();
          }}
        />
      )}
      {editing && (
        <SmartFolderDialog
          initial={editing.folder}
          preset={editing.preset}
          courses={courseList}
          onClose={() => setEditing(null)}
          onSave={(folder) => {
            // Edited: in its place (and the view follows it); new: at the end.
            const old = editing.folder;
            const others = without(pinned, folder).filter((p) => !old || !same(p, old));
            const at = old ? pinned.findIndex((p) => same(p, old)) : pinned.length;
            savePinned(putAt(others, folder, Math.min(at, others.length)));
            setEditing(null);
            go({ kind: "search", search: thingOf(folder) as ThingOf<"search"> });
          }}
        />
      )}
    </div>
    </ThingsContext.Provider>
  );
}

// -- pieces -----------------------------------------------------------------------------

/** 置顶: what's pinned, in the order you put it in. Anything dropped on it is pinned where you let
 * go (a line shows where); dragged off it, it's unpinned. */
function PinnedSection({ items, collapsed, header, empty, render, onMove, onPin, onUnpin }: {
  items: Shown[];
  collapsed: boolean;
  header: React.ReactNode;
  empty: React.ReactNode;
  render: (item: Shown) => React.ReactNode;
  onMove: (from: number, to: number) => void;
  onPin: (entry: Shown, at?: number) => void;
  onUnpin: (item: Shown) => void; // dragged off the list
}) {
  const list = useRef<HTMLDivElement>(null);
  const slotAt = (_x: number, y: number) => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>(":scope > [data-pin]") ?? []);
    const i = rows.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return i < 0 ? rows.length : i;
  };
  const zone = useDropZone((entry, at) => onPin(entry, collapsed ? undefined : at), slotAt);
  const drag = useReorder(items.length, onMove, "y", {
    zone: zone.id,
    thing: (i) => items[i], // (onto a course's tabs, its overview)
    remove: (i) => () => onUnpin(items[i]),
  });
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
function TermSection({ group, sectionRef, grab, collapsed, onToggle, onMenu, onReorder, renderCourse }: {
  group: TermGroup;
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
function pinnedWhere(path: string, c: Course | null): string {
  if (c && path === c.dir) return c.term_label ?? "";
  if (c) return c.label;
  return parentOf(path) || t("全部文件");
}

/** What to do about a notice, from it: 撤销, say. */
export type NoticeAction = { label: string; run: () => void };
type NoticeState = { text: string; action?: NoticeAction };

/** A short message at the bottom of the window that goes away by itself (a little later when
 * there's something to do about it). */
function Notice({ notice, onDone }: { notice: NoticeState | null; onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => done.current(), notice.action ? 8000 : 5000); // per message, not per re-render
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-lg border border-line bg-panel px-4 py-2 text-sm shadow-xl">
      {notice.text}
      {notice.action && (
        <button
          onClick={() => {
            notice.action!.run();
            done.current();
          }}
          className="shrink-0 font-medium text-accent hover:underline"
        >
          {notice.action.label}
        </button>
      )}
    </div>
  );
}

function Results({ view, mode, results, asked, scope, showCourse, onOpen, onReveal, onMenu, onDelete }: {
  view: View;
  mode: ViewMode;
  query: string;
  results: { hits: Hit[]; error: string | null; loading: boolean };
  asked: boolean; // a search was typed, or is saved (a smart folder)
  scope?: { text: string; action: string; onAction: () => void } | null;
  onReveal: (hit: Hit) => void;
  showCourse: boolean;
  onOpen: (hit: Hit) => void;
  onMenu: (hits: Hit[], x: number, y: number) => void;
  onDelete: (hits: Hit[]) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const { hits, error, loading } = results;
  useEffect(() => setKind(null), [view]);
  const shown = kind ? hits.filter((h) => h.kind === kind) : hits;
  const counts: Partial<Record<Kind, number>> = {};
  for (const h of hits) counts[h.kind] = (counts[h.kind] ?? 0) + 1;

  const header = (
    <>
      {scope && (
        <p className="mb-2 flex items-center gap-2 px-2 text-xs text-muted">
          {scope.text}
          <button onClick={scope.onAction} className="text-accent hover:underline">{scope.action}</button>
        </p>
      )}
      {hits.length > 0 && Object.keys(counts).length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-2 text-xs">
          <Chip active={!kind} onClick={() => setKind(null)}>{t("全部")} {hits.length}</Chip>
          {(Object.keys(KIND) as Kind[]).filter((k) => counts[k]).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{KIND[k].label} {counts[k]}</Chip>
          ))}
        </div>
      )}
      {error && <p className="px-2 py-6 text-sm text-danger whitespace-pre-wrap">{error}</p>}
      {!error && asked && !loading && shown.length === 0 && <p className="px-2 py-10 text-center text-sm text-muted">{t("没有结果")}</p>}
    </>
  );
  return <HitBrowser hits={shown} mode={mode} showCourse={showCourse} header={header} onOpen={onOpen} onReveal={onReveal} onMenu={onMenu} onDelete={onDelete} />;
}

/** 搜索 in the main window: everything by name, and what the index finds (see Found.tsx). What
 * search knows is loaded again each time it's shown (what you opened since counts). */
function SearchHome({ input, query, onQuery, version, courses, onOpen, props }: {
  input: React.ReactNode;
  query: string;
  onQuery: (q: string) => void;
  version: number;
  courses: Course[];
  onOpen: (f: Found | undefined, how: How) => void;
  props: (f: Found) => object;
}) {
  const { catalog, vocab, usage, names } = useCatalog([version], courses);
  const actions = useMemo(() => actionsFor(names), [names]);
  return (
    <FoundSearch input={input} query={query} onQuery={onQuery} catalog={catalog} vocab={vocab} usage={usage} names={names} courses={courses}
      actions={actions} onOpen={onOpen} props={props} welcome={<Welcome />} />
  );
}

function SearchInput({ inputRef, value, onChange, placeholder, compact, autoFocus }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 focus-within:border-accent ${compact ? "w-56 shrink-0" : ""}`}>
      <Search className="size-4 shrink-0 text-muted" aria-hidden />
      <input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        // A query ("mt", "hw3 sol"), not prose: no autocorrect or capitals.
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={placeholder}
        className={`w-full bg-transparent outline-none placeholder:text-muted ${compact ? "h-7 text-sm" : "h-10"}`}
      />
    </div>
  );
}

/** Where you are. In a course it starts at the course (its name, not where its files live). */
function Breadcrumb({ path, root = { path: "", label: t("全部文件") }, onGo }: {
  path: string;
  root?: { path: string; label: string; icon?: React.ReactNode };
  onGo: (p: string) => void;
}) {
  const rest = path.slice(root.path.length).replace(/^\//, "");
  const parts = rest ? rest.split("/") : [];
  const prefix = root.path ? root.path + "/" : "";
  return (
    <nav className="flex min-w-0 items-center gap-0.5 text-sm" aria-label={t("位置")}>
      <button onClick={() => onGo(root.path)} className={`flex shrink-0 items-center gap-1.5 truncate rounded px-1.5 py-0.5 hover:bg-chip ${parts.length ? "text-muted" : "font-medium"}`}>
        {root.icon}
        {root.label}
      </button>
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight className="size-3.5 shrink-0 text-muted" />
          <button
            onClick={() => onGo(prefix + parts.slice(0, i + 1).join("/"))}
            className={`truncate rounded px-1.5 py-0.5 hover:bg-chip ${i === parts.length - 1 ? "font-medium" : "text-muted"}`}
          >
            {p}
          </button>
        </span>
      ))}
    </nav>
  );
}

function SmartTitle({ folder, name, courses }: { folder: ThingOf<"search">; name: string; courses: Course[] }) {
  const names = folder.courses.map((id) => courses.find((c) => c.id === id)?.label ?? `#${id}`);
  const bits = [
    folder.query && `“${folder.query}”`,
    names.length ? names.join(t("、")) : t("所有课程"),
    folder.kinds.length ? folder.kinds.map((k) => KIND[k].label).join(t("、")) : "",
    folder.content ? t("含正文") : t("只看名称"),
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium"><Sparkles className="size-4 text-accent" />{name}</span>
      <span className="truncate text-xs text-muted">{bits.join(" · ")}</span>
    </div>
  );
}

function NavItem({ icon, title, subtitle, active, count, muted, onClick, onMenu }: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  active: boolean;
  muted?: boolean;
  count?: number; // new things in it
  onClick: () => void;
  onMenu?: (x: number, y: number) => void;
}) {
  return (
    <div className="group relative">
      <button
        onClick={onClick}
        onContextMenu={onMenu && ((e) => (e.preventDefault(), onMenu(e.clientX, e.clientY)))}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${active ? "bg-selected text-fg" : "text-fg-soft hover:bg-chip"} ${muted ? "opacity-50" : ""}`}
      >
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{title}</span>
          {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
        </span>
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

function SectionHeader({ title, action, onMenu, collapsed, onToggle, grab, count = 0 }: {
  title: string;
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
      onContextMenu={onMenu && ((e) => (e.preventDefault(), onMenu(e.clientX, e.clientY)))}
    >
      <h2 className="min-w-0 flex-1">
        <button
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
        </button>
      </h2>
      {/* What's new in a folded section; on hover, its actions take the place. */}
      {count > 0 && <span className="group-hover:hidden"><Count n={count} label={t("{n} 个新的", { n: count })} /></span>}
      {action && (
        <button
          title={action.label}
          aria-label={action.label}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            action.onClick(r.left, r.bottom + 2);
          }}
          className={`rounded p-0.5 text-muted hover:bg-chip hover:text-fg ${count > 0 ? "hidden group-hover:block" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        >
          {action.icon}
        </button>
      )}
    </div>
  );
}

function ToolButton({ title, onClick, disabled, pressed, children }: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-1.5 disabled:opacity-30 ${pressed ? "bg-chip text-fg" : "text-muted hover:bg-chip hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 ${active ? "border-accent bg-accent text-on-accent" : "border-line text-fg-soft hover:bg-chip"}`}
    >
      {children}
    </button>
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
  pin: (n) => t("记住了 {n} 个新位置", { n }),
};

function SyncStatus({ sync, label, onFix }: { sync: SyncState | null; label: string; onFix: () => void }) {
  if (!sync || sync.phase === "idle") return null;
  const pct = sync.total ? Math.round((sync.done / sync.total) * 100) : null;
  const changes = Object.entries(sync.changes).map(([k, n]) => CHANGE[k]?.(n) ?? `${n} ${k}`).join(t("，"));
  return (
    <div className="mx-4 mb-2 rounded-md bg-chip px-2.5 py-2 text-xs text-fg-soft">
      <div className="flex justify-between gap-2">
        <span className={`truncate ${sync.phase === "failed" ? "text-danger" : ""}`}>
          {PHASE[sync.phase]}{label && sync.scope.length > 0 ? ` · ${label}` : ""}
        </span>
        {sync.running && pct !== null && <span className="shrink-0">{sync.done}/{sync.total}</span>}
      </div>
      {sync.running && pct !== null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {sync.running && sync.current && <p className="mt-1 truncate text-muted">{sync.current.split("/").pop()}</p>}
      {sync.phase === "done" && <p className="mt-0.5 text-muted">{changes || t("没有新内容")}</p>}
      {sync.errors.slice(0, 3).map((e) => (
        <p key={e} className="mt-1 break-words text-danger">{e}</p>
      ))}
      {sync.errors.some((e) => /401|token/i.test(e)) && (
        <button onClick={onFix} className="mt-1 text-accent hover:underline">{t("Canvas 令牌可能过期了，到设置里更换")}</button>
      )}
    </div>
  );
}

function Welcome() {
  return (
    <div className="mx-auto max-w-md px-2 py-16 text-sm text-muted">
      <p className="mb-4 text-base text-fg">
        {tx("在任何地方按 {key} 快速搜索。", { key: <kbd className="rounded border border-line bg-chip px-1.5">{shortcut.launcher}</kbd> })}
      </p>
      <p>
        {tx("输入课程名加关键词，例如 {a}、{b}、{c}。也可以按类型、时间、提交状态找，例如 {d}、{e}。缩写会自动展开（mt = midterm，hw3 = Homework 3 = Problem Set 3），拼错也能找到。", {
          a: <code className="text-fg-soft">221 mt</code>,
          b: <code className="text-fg-soft">cs70 hw3 sol</code>,
          c: <code className="text-fg-soft">{t("期中")}</code>,
          d: <code className="text-fg-soft">{t("cs70 本周截止")}</code>,
          e: <code className="text-fg-soft">{t("未交")}</code>,
        })}
      </p>
      <p className="mt-3">{t("左边选一门课可以浏览它的文件；右键课程、文件夹或文件可以单独同步或恢复。")}</p>
    </div>
  );
}

export function StartupError({ message }: { message: string }) {
  return (
    <div data-tauri-drag-region className="flex h-screen items-center justify-center bg-bg p-8 text-fg">
      <div className="max-w-lg">
        <h1 className="mb-2 text-lg font-semibold">{t("后台服务没有启动")}</h1>
        <pre className="overflow-auto rounded-md bg-chip p-3 text-xs whitespace-pre-wrap text-danger">{message}</pre>
      </div>
    </div>
  );
}
