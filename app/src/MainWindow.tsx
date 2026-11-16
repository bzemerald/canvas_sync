import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronLeft, ChevronRight, Eye, EyeOff, FolderTree, LayoutGrid, List, ListChecks, Paperclip, Plus, RefreshCw, Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./components/Dialog";
import { FileBrowser, canRename, parentOf, type ViewMode } from "./components/FileBrowser";
import { type Finder, FinderContext, FoundHere, type How, actionsFor, rememberCourse, useCatalog } from "./components/Found";
import { Marked } from "./components/Marked";
import {
  CourseDoc, CourseGrades, CourseModules, CourseReader, CourseTabs, NewTab, useOverview,
} from "./components/CourseView";
import { CourseOverview, LinksPage, NoteEditor } from "./components/Overview";
import { DeleteDialog } from "./components/DeleteDialog";
import { CourseIconDialog } from "./components/CourseIconDialog";
import { HideCourseDialog } from "./components/HideCourseDialog";
import { KeysDialog } from "./components/KeysDialog";
import { ContextMenu, type MenuItem, type MenuState } from "./components/Menu";
import { Notice, type NoticeAction, type NoticeState } from "./components/Notice";
import { usePlace } from "./components/Place";
import { RenameInput } from "./components/RenameInput";
import { RestoreDialog } from "./components/RestoreDialog";
import { Results } from "./components/Results";
import { Settings } from "./components/Settings";
import { NavItem, PinnedSection, SectionHeader, SyncStatus, TermSection, UpdateNotice, arrange, groupByTerm, pinnedWhere } from "./components/Sidebar";
import { Breadcrumb, SearchInput, SmartTitle, ToolButton } from "./components/Toolbar";
import { SmartFolderDialog, type SmartFolder } from "./components/SmartFolderDialog";
import {
  ThingIcon, ThingsContext, onTheWeb, ownName, pinItem, sections, thingName, thingOfEntry, type Things,
} from "./components/Things";
import * as api from "./lib/api";
import { courseUrl, docUrl } from "./lib/canvas";
import { quickLook } from "./lib/quicklook";
import type { AccountInfo, Course, CourseLayout, Entry, Hit, NewsView, Place, Scope, SidebarOrder } from "./lib/api";
import type { Found, Scope as Where } from "./lib/find";
import { markPattern } from "./lib/marks";
import {
  type CourseView, START, type Spare, VIEW_LISTS, type View, firstTab, listed, replaced, settle, showing as isShowing, showsFiles, spareKey, spareOf,
  stepped, toTab as tabOf, under, went, withoutSpare,
} from "./lib/navigation";
import { type Reading, read } from "./lib/query";
import { appCommand, copyName, fileManager, isMac, shortcut, trashName } from "./lib/keys";
import { VIEWS } from "./lib/kinds";
import { copyFiles } from "./lib/copyFiles";
import { clickSearchButton, keysLabel, pressSearchButton, showLauncher, useLauncherKeys } from "./lib/launcherKeys";
import { usePref } from "./lib/prefs";
import { useSearch } from "./lib/useSearch";
import { useSync } from "./lib/useSync";
import { CourseIcon } from "./lib/courseIcons";
import { moved, useReorder } from "./lib/reorder";
import {
  type Shown, type Thing, type ThingOf, type ViewName, folderTitle, fromEd, isView, ofCourse, opensElsewhere, putAt, setFolderTitles, same, thingKey, thingNamed, thingOf, thingOfHit,
  view as viewOf, without,
} from "./lib/things";
import { ownFrame, useTrafficLights } from "./lib/window";
import { startUpdateChecks } from "./lib/update";
import { friendly } from "./lib/errors";
import { SignInDialog, browserSignIn } from "./components/SignIn";
import { t, tn } from "./lib/i18n";
import { reload, useLoaded, useReloads } from "./lib/useLoaded";

/** The open course's page: its places, each with all they hold (as last loaded, or as just changed). */
type Layout = { [P in Place]: Shown[] } & { own: CourseLayout["own"] };
const layouts = new Map<number, Layout>(); // each course's, as last loaded: drawn at once when it's opened again

const RESTORABLE = new Set(["modified", "missing", "ignored"]);
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const countLabel = (names: string[]) => (names.length === 1 ? names[0] : tn("1 item", "{n} items", { n: names.length }));
/** The views that count what's new in them. */
const countsNew = (v: ViewName): v is NewsView => ["announcements", "assignments", "pages", "files", "ed"].includes(v);
// Views that narrow their own lists as you type in the search box.
const FILTERS_ITSELF: ViewName[] = ["announcements", "assignments", "pages", "ed", "modules", "grades"];
// What a tab shows, searched from it: that comes a little first.
const VIEW_FINDS: Partial<Record<ViewName, Pick<Where, "kind" | "source">>> = {
  announcements: { kind: "announcement" }, assignments: { kind: "assignment" }, pages: { kind: "page" }, ed: { source: "ed" },
  modules: { kind: "module" }, files: { kind: "file" },
};
// A course's Files shows its Files folder as itself (what Canvas's Files has), and the folders of
// what's from elsewhere in the course first, saying what they are.
const inlineOf = (c: Course, tab: Thing | null) => (tab && isView(tab, "files") ? c.source_dirs.files : undefined);
const marks = new WeakMap<Course, React.ComponentProps<typeof FileBrowser>["marked"]>(); // (one per course loaded: the list keeps its order)
const sourceMarks = (c: Course) => {
  if (!marks.has(c)) {
    marks.set(c, {
      ...(c.source_dirs.modules ? { [c.source_dirs.modules]: { icon: ListChecks, note: t("Files in modules") } } : {}),
      ...(c.source_dirs.attachments ? { [c.source_dirs.attachments]: { icon: Paperclip, note: t("Attached to pages, assignments, announcements") } } : {}),
    });
  }
  return marks.get(c);
};
const shownOn = (tab: Thing | null): Pick<Where, "kind" | "source"> =>
  !tab ? {} : isView(tab) ? VIEW_FINDS[tab.view] ?? {} : tab.type === "doc" ? { kind: tab.kind } : tab.type === "module" ? { kind: "module" } : tab.type === "folder" ? { kind: "file" } : {};

export function MainWindow() {
  const launcherKeys = useLauncherKeys();
  const [courseList, setCourseList] = useState<Course[]>([]);
  const [pinned, setPinned] = useState<Shown[]>([]);
  const [hist, setHist] = useState(START); // where it is, and was (lib/navigation.ts)
  const [query, setQuery] = useState("");
  const [mode, setMode] = usePref<ViewMode>("viewMode", "list");
  const [showChanges, setShowChanges] = usePref("showChanges", false); // what you changed, in files
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [signingIn, setSigningIn] = useState(false); // signed out: signing in again (SignInDialog)
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
  const [changes, setChanges] = useState<Record<number, number>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [restoring, setRestoring] = useState<{ scope: Scope; label: string } | null>(null);
  const [showingKeys, setShowingKeys] = useState(false); // the keyboard shortcuts
  const [completing, setCompleting] = useState<string | null>(null); // what ⇥ would make of the search box's query
  const [deleting, setDeleting] = useState<{ paths: string[]; label: string } | null>(null);
  const [editing, setEditing] = useState<{ folder: SmartFolder | null; preset?: Partial<SmartFolder> } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null); // a folder being renamed in place
  const [renamingHere, setRenamingHere] = useState<string | null>(null); // the sidebar's row: course:<id>, term:<key>, pin:<thing>
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
    setHist((h) => went(h, v));
  }, []);
  const step = (d: number) => setHist((h) => stepped(h, d));
  /** Change where we are without a new history entry (picking an item in a list). */
  const replaceView = (v: View) => setHist((h) => replaced(h, v));
  /** Everything shown loads again (a sync ended, the window came back, something was changed). */
  const refresh = () => reload();
  /** You opened something: what says what's new loads again. */
  const seenChanged = () => reload("courses", "overview", "new-files");
  const newFiles = useLoaded("new-files", api.newFiles, { follow: true }).value; // (what a file's menu can mark read)

  useEffect(startUpdateChecks, []);

  // -- data ------------------------------------------------------------------------
  const coursesReloaded = useReloads("courses");
  const pinnedReloaded = useReloads("pinned");
  const sidebarReloaded = useReloads("sidebar");
  const titlesReloaded = useReloads("folder-titles");
  const statusReloaded = useReloads("status");
  useEffect(() => {
    api.courses().then(setCourseList, (e) => api.isFolderMissing(e) || setStartupError(String(e.message ?? e)));
  }, [coursesReloaded]);
  useEffect(() => void api.pinned().then(setPinned, () => {}), [pinnedReloaded]);
  useEffect(() => void api.sidebarOrder().then(setOrder, () => {}), [sidebarReloaded]);
  const [, setTitled] = useState(0); // (folder titles came: show them)
  useEffect(() => {
    void api.folderTitles().then((titles) => {
      setFolderTitles(titles);
      setTitled((n) => n + 1);
    }, () => {});
  }, [titlesReloaded]);
  useEffect(() => void api.account().then(setAccount, () => {}), []);
  // The sync: where it's got to, starting one; when one ends, what it changed is loaded again.
  const { sync, label: syncLabel, busy: syncBusy, run: runSync, renewing } = useSync({
    account, onAccount: setAccount, onFinished: refresh, signIn: (site) => browserSignIn(site, true),
  });
  useEffect(() => {
    api.status().then((all) => {
      const counts: Record<number, number> = {};
      for (const s of all) if (s.states.some((x) => RESTORABLE.has(x))) counts[s.course_id] = (counts[s.course_id] ?? 0) + 1;
      setChanges(counts);
    }, () => {});
  }, [statusReloaded]);

  // Files change behind our back (you edit them in other apps): look again on focus.
  useEffect(() => {
    const off = getCurrentWindow().onFocusChanged(({ payload }) => payload && refresh());
    return () => void off.then((f) => f());
  }, []);

  // Window-wide keys (back, forward, search, show changes, sync, the next course...), per
  // platform; and the mouse's back / forward buttons. (What they do: `onKey`, below, as of now.)
  const onKey = useRef((_: KeyboardEvent) => {});
  useEffect(() => {
    const key = (e: KeyboardEvent) => onKey.current(e);
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) step(-1);
      else if (e.button === 4) step(1);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mouseup", onMouse);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- the open course's page: its tabs, overview and Tools and links, arranged for it or as every course's --
  const courseById = (id: number) => courseList.find((c) => c.id === id) ?? null;
  const courseAt = (path: string) => courseList.find((c) => under(path, c.dir)) ?? null;
  const layoutId = raw.kind === "course" ? raw.id : null;
  const layoutReloaded = useReloads("layout");
  useEffect(() => {
    if (layoutId === null) return;
    let live = true;
    api.courseLayout(layoutId).then((l) => live && keepLayout(layoutId, l), () => {});
    return () => {
      live = false;
    };
  }, [layoutId, layoutReloaded]);
  const courseLayout = layout && layout.id === layoutId ? layout.layout : layoutId !== null ? layouts.get(layoutId) ?? null : null;
  const tabs = courseLayout?.tabs ?? [];
  /** Going to one of the course's tabs (or showing something there). */
  const toTab = (v: CourseView, x: Thing): CourseView => tabOf(v, x, courseById(v.id)?.dir);
  // Where the page is, once the course's tabs are known (see `settle`).
  const view: View = raw.kind === "course" && courseLayout && layout?.id === raw.id ? settle(raw, tabs, courseById(raw.id)?.dir) : raw;
  const cv = view.kind === "course" ? view : null;
  // The course you were last in: search (here and in the search window) puts its things a little first.
  useEffect(() => {
    if (cv) rememberCourse(cv.id);
  }, [cv?.id]);
  // Where you were in each course (this run of the app): opening it again goes back there.
  const lastIn = useRef(new Map<number, CourseView>());
  useEffect(() => {
    if (cv) lastIn.current.set(cv.id, cv);
  }, [cv]);
  const course = cv ? courseById(cv.id) : null;
  const tab = cv?.tab ?? null;
  // The tab at the end of each course's tabs (this run of the app): the new tab, or something shown
  // that isn't one of its tabs. Showing one puts it there, in place of what was; going to another
  // tab, it stays, until closed.
  const [spares, setSpares] = useState<ReadonlyMap<number, Spare>>(new Map());
  const setSpare = (id: number, s: Spare | null) =>
    setSpares((m) => {
      if (spareKey(m.get(id)) === spareKey(s)) return m;
      const next = new Map(m);
      if (s) next.set(id, s);
      else next.delete(id);
      return next;
    });
  const lastTab = useRef(new Map<number, Thing>()); // the tab you were last on, in each course
  const settled = !!cv && !!courseLayout && layout?.id === cv.id; // (see settle)
  const shownSpare: Spare | null = cv ? spareOf(cv, tabs, settled) : null;
  const kept = cv ? spares.get(cv.id) : undefined;
  const keptListed = !!kept && kept !== "new" && listed(tabs, kept); // (made a tab: it's not kept there any more)
  const spare = shownSpare ?? (keptListed ? null : kept ?? null);
  useEffect(() => {
    if (!cv || !settled) return;
    if (shownSpare) setSpare(cv.id, shownSpare);
    else {
      lastTab.current.set(cv.id, cv.tab);
      if (keptListed) setSpare(cv.id, null);
    }
  }, [cv?.id, settled, spareKey(shownSpare), spareKey(kept), keptListed, tab && thingKey(tab)]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabEntry = tab ? tabs.find((e) => same(e, tab)) ?? tab : null;
  const filesTab = showsFiles(view);
  const filesView = view.kind === "browse" || view.kind === "course"; // has a search box for where it is
  const browsing = filesView ? view.path : null; // (a course's other tabs remember a folder, but don't show it)

  /** Go to a folder: inside a course, that's the course's page (in Files, or a folder tab that has
   * it); elsewhere, a plain folder. */
  const goPath = (path: string, select?: string, found?: string) => {
    const c = courseAt(path);
    if (!c) return go({ kind: "browse", path, select, found });
    // (In Files, or a folder tab that has it: it stays there.)
    const stay = cv && cv.id === c.id && tab && (isView(tab, "files") || (tab.type === "folder" && under(path, tab.path)));
    if (stay && path === inlineOf(c, tab)) path = c.dir; // (it's shown as the course's own)
    go({ kind: "course", id: c.id, tab: stay ? tab : { type: "folder", path }, path, select, found });
  };
  /** Go into a folder from the one showing: All files stays All files, even in a course's folder. */
  const goFolder = (path: string) => (view.kind === "browse" ? go({ kind: "browse", path }) : goPath(path));
  /** A course opens where you last were in it; the first time, or from inside it, on its first
   * tab (Overview, unless that course's Overview is hidden). */
  const openCourse = (c: Course, found?: string) => {
    const last = cv?.id === c.id ? null : lastIn.current.get(c.id);
    go(last ? { ...last, select: undefined, found } : { kind: "course", id: c.id, tab: viewOf(c.id, "overview"), path: c.dir, first: true, found });
  };
  const launchTool = (x: ThingOf<"tool">) => {
    const key = thingKey(x);
    setOpening(key);
    api.launch(x.course, { tool_id: x.tool })
      .catch(fail(t("Couldn't open it")))
      .finally(() => setOpening((k) => (k === key ? null : k)));
  };
  /** Going somewhere in the course from its new tab (picking it there, opening it while the new
   * tab shows): the new tab turns into it, a tab for now, or none (it has a tab). */
  const intoNewTab = (x: Thing) => {
    if (cv?.blank && course && !opensElsewhere(x) && ofCourse(x, course)) setSpare(cv.id, null);
  };
  /** The tab at the end, closed; showing, back to the tab you were on before it. */
  const closeSpare = () => {
    if (!cv) return;
    setSpare(cv.id, null);
    if (cv.blank || shownSpare) replaceView(withoutSpare(cv, tabs, lastTab.current.get(cv.id), courseById(cv.id)?.dir));
  };
  /** Anything, wherever it opens: a file in its app; a tool, a link, the course on Canvas in the
   * browser; a search as a smart folder; the rest in its course's page. Noted, with what had been
   * typed in search (`query`): what you open most and lately comes first there. `found`: what to
   * mark where it shows. */
  const open = (x: Thing, query = "", found?: string) => {
    api.noteOpened(thingKey(x), query);
    intoNewTab(x);
    if (x.type === "course") {
      const c = courseById(x.course);
      if (c) openCourse(c, found);
    } else if (x.type === "folder") goPath(x.path, undefined, found);
    else if (x.type === "file") void api.openPath(x.path).then(seenChanged, fail(t("Couldn't open it")));
    else if (x.type === "link") void api.openExternal(x.url);
    else if (x.type === "tool") launchTool(x);
    else if (x.type === "search") go({ kind: "search", search: x, found });
    else if (isView(x, "canvas")) void api.openUrl(courseUrl(x.course));
    else if (cv && cv.id === x.course) {
      // (On Ed's list, what's from Ed is there: it needn't go to its kind's.)
      go({ ...(x.type === "doc" && fromEd(x) && isView(cv.tab, "ed") ? { ...toTab(cv, viewOf(x.course, "ed")), item: x.id } : toTab(cv, x)), found });
    } else if (courseById(x.course)) go({ kind: "course", id: x.course, tab: x, path: courseById(x.course)!.dir, found });
  };
  const openIn = (x: Thing, list: ViewName) => {
    if (x.type !== "doc" || cv?.id !== x.course) return open(x);
    api.noteOpened(thingKey(x));
    go({ ...toTab(cv, viewOf(x.course, list)), item: x.id });
  };
  /** What's marked on what's opened from a list of results: the words that found it. */
  const foundBy = (h?: Hit) => markPattern(read(smart?.query ?? query, vocab), vocab, h?.snippet);
  const openHere = (h: Hit) => {
    const x = thingOfHit(h);
    return x ? open(x, "", foundBy(h)) : void api.openHit(h);
  };
  const overview = useOverview(cv ? cv.id : null);

  // The search window asks us to open something (a course's view, an announcement…), to show a
  // file in its folder, or to do something (sync, settings).
  const openLater = useRef(open);
  openLater.current = open;
  const goPathLater = useRef(goPath);
  goPathLater.current = goPath;
  const runLater = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    const offs = [
      listen<{ thing: Thing; query: string; found?: string }>("open-thing", ({ payload }) => openLater.current(payload.thing, payload.query, payload.found)),
      listen<{ path: string; found?: string }>("show-path", ({ payload }) => goPathLater.current(parentOf(payload.path), payload.path, payload.found)),
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

  // What the search box searches. In a course, what the tab shows: Announcements / Assignments / Pages / Modules / Grades
  // narrow their own lists as you type, Files (or a folder tab) searches the folder you're in;
  // anything else, the course. Elsewhere, the folder you're in (in All files, any: still only files).
  // "Search the whole course" widens it to the course.
  const filtering = !!tab && !cv?.blank && !wide && isView(tab) && tab.course === cv?.id && FILTERS_ITSELF.includes(tab.view);
  const folderScope = !wide && ((cv && filesTab) || view.kind === "browse") ? browsing : null;
  const courseWide = !!cv && !filesTab && (!!cv.blank || !(isView(tab) && FILTERS_ITSELF.includes(tab.view)));
  const tabName = tabEntry ? thingName(tabEntry, courseList, "tab") : "";
  const folderName = (path: string) => (course && path === course.dir ? VIEWS.files.tab : path === "" ? t("All files") : folderTitle(path));
  useEffect(() => {
    if (!query.trim()) setWide(false);
  }, [query]);
  const searching = filesView && query.trim() !== "" && !filtering;
  const searchPlaceholder =
    cv && course
      ? wide || courseWide
        ? t("Search {label}", { label: course.label })
        : filesTab
          ? t("Search “{name}”", { name: folderName(cv.path) })
          : t("Search {scope}", { scope: tabName })
      : view.kind === "browse"
        ? t("Search “{name}”", { name: folderName(view.path) })
        : t("Search");
  // A smart folder's results (typing in its box searches where it is instead: below).
  const smart = searched && !query.trim() ? searched : null;
  const smartReloaded = useReloads("smart-folder");
  const results = useSearch(
    smart ? thingKey(smart) : "",
    () => (smart ? api.search(smart.query, { courses: smart.courses, kinds: smart.kinds, namesOnly: !smart.content, limit: 500 }) : Promise.resolve([])),
    [smartReloaded],
  );
  // What's typed is searched as in the search window, where the box is: the folder,
  // the course (what its tab shows a little first), or everything.
  const scope = useMemo((): Where => {
    if (folderScope !== null) return { under: folderScope, ...(cv ? { courses: [cv.id] } : folderScope && scopeCourses.length ? { courses: scopeCourses } : {}) };
    return cv ? { courses: [cv.id], ...shownOn(cv.blank ? null : tab) } : {};
  }, [folderScope, cv?.id, cv?.blank, scopeCourses.join(","), tab && thingKey(tab)]); // eslint-disable-line react-hooks/exhaustive-deps
  const { catalog, vocab, usage, names } = useCatalog([], courseList, query.trim() !== "" || !!smart);
  const finder = useMemo((): Finder => ({ catalog, vocab, usage, names, courses: courseList }), [catalog, vocab, usage, names, courseList]);
  const actions = useMemo(() => actionsFor(names), [names]);
  const box = useMemo(() => ({ query: filtering ? query : "", onQuery: setQuery, onWiden: () => setWide(true) }), [filtering, query]);
  // What's marked on the page: what its box narrows it to, as you type; else what search opened it for.
  const narrowed = useMemo(() => (filtering && query.trim() ? markPattern(read(query, vocab), vocab) ?? null : null), [filtering, query, vocab]);
  const marking = narrowed ?? (searching ? null : view.found ?? null);
  const clearMarks = useCallback(() => setHist((h) => replaced(h, { ...h.stack[h.i], found: undefined } as View)), []);
  /** Above the results: what was searched, and the way to search more (or less) widely. */
  const scopeNote = (() => {
    if (!query.trim()) return null;
    if (cv && course) {
      if (wide && !courseWide) {
        const narrow = filesTab ? folderName(cv.path) : tabName;
        return { text: t("Search {label}", { label: course.label }), action: t("Only “{name}” ›", { name: narrow }), onAction: () => setWide(false) };
      }
      if (folderScope !== null) {
        return { text: t("Files in “{name}”", { name: folderName(folderScope) }), action: t("Search the whole course ›"), onAction: () => setWide(true) };
      }
      return { text: t("Search {label}", { label: course.label }), action: t("Search all courses ›"), onAction: () => searchEverywhere(query) };
    }
    if (view.kind === "browse" && folderScope !== null) {
      return { text: folderScope ? t("Files in “{name}”", { name: folderName(folderScope) }) : t("Files only"), action: t("Search everything ›"), onAction: () => setWide(true) };
    }
    return null;
  })();

  /** What's typed, searched in all courses (in the search window). */
  const searchEverywhere = (q: string) => void showLauncher(q);

  // -- actions --------------------------------------------------------------------------
  const signedOut = account !== null && !account.signed_in;
  /** What search can do (see Found.tsx): sync everything or a course, settings, a smart folder. */
  const runAction = (id: string) => {
    const c = id.startsWith("sync:") ? courseById(Number(id.slice(5))) : null;
    if (id === "sync") void startSync({}, t("All courses"));
    else if (c) void startSync({ paths: [c.dir] }, c.label);
    else if (id === "settings") go({ kind: "settings" });
    else if (id === "smart-folder") setEditing({ folder: null });
  };
  runLater.current = runAction;
  /** Something search found: opened (↵), shown in its folder (⌘↵), or on Canvas (⌘⇧↵). */
  const openFound = (f: Found | undefined, how: How, reading: Reading) => {
    if (!f) return;
    searchBox.current?.blur(); // what opens takes the keys (a folder's list)
    if (f.type === "action") {
      api.noteOpened(f.key, query);
      return runAction(f.action.id);
    }
    const path = f.type === "hit" ? f.hit.path : f.entry.type === "file" ? f.entry.path : null;
    const found = markPattern(reading, vocab, f.hit?.snippet);
    if (how === "reveal" && path) {
      intoNewTab({ type: "folder", path: parentOf(path) });
      return goPath(parentOf(path), path, found);
    }
    if (f.type === "hit") {
      if (how === "canvas") return void api.openCanvas(f.hit);
      const x = thingOfHit(f.hit);
      return x ? open(x, query, found) : void api.openHit(f.hit);
    }
    if (how === "canvas") {
      const url = f.entry.canvas_url;
      if (url) void api.openUrl(url).then(() => api.noteOpened(f.key, query));
      return;
    }
    open(thingNamed(f.entry), query, found);
  };
  /** Whether it started: not if signed out (then: sign in first; the sidebar offers it too when a
   * sign-in expired and couldn't be renewed quietly), or if one is already running (that one is
   * shown). `runSync` starts it already signed in (just now: `signedOut` is still this render's). */
  const startSync = async (scope: Scope, label: string): Promise<boolean> => {
    if (signedOut) {
      setSigningIn(true);
      return false;
    }
    return runSync(scope, label);
  };
  const openMenu = (items: MenuItem[], x: number, y: number) => setMenu({ x, y, items });
  const reveal = (path: string) => void api.openPath(path, { reveal: true });

  const say = (message: string, action?: NoticeAction) => setNotice({ text: message, action });
  const fail = (what: string) => (e: unknown) => say(t("{what}: {why}", { what, why: friendly((e as Error).message) }));
  /** Files and folders to the clipboard, to paste in Finder / Explorer or another app. */
  const copy = (paths: string[], names: string[]) =>
    void copyFiles(paths).then((ok) => {
      const what = countLabel(names);
      say(ok ? (isMac ? t("Copied {what}@@mac", { what }) : t("Copied {what}", { what })) : isMac ? t("Couldn't copy {what}@@mac", { what }) : t("Couldn't copy {what}", { what }));
    });
  const copyItem = (paths: string[], names: string[]): Exclude<MenuItem, "separator"> => ({ label: copyName, hint: shortcut.copy, onSelect: () => copy(paths, names) });

  // -- places: Pinned, and the open course's tabs, overview and Tools and links -------------------
  /** Pinned as it should be. */
  const savePinned = (next: Shown[]) => {
    setPinned(next);
    api.arrangePinned(next).then(setPinned, fail(t("That didn't work")));
  };
  const nameOf = (x: Shown) => thingName(x, courseList);
  // Pinned is a place like a course's, with nothing of its own. A smart folder is only here: taken
  // away, it's gone (Undo brings it back).
  const pins = usePlace({
    entries: pinned, onArrange: savePinned, onSay: say, name: nameOf,
    taken: (name, e) => (e.type === "search" ? t("Deleted the smart folder “{name}”", { name }) : t("Unpinned “{name}”", { name })),
  });
  const isPinned = (x: Thing) => pinned.some((p) => same(p, x));
  /** Pinned (at a place in the list: dropped there; else at the end, said so). */
  const pinThing = (x: Shown, at?: number) => {
    if (isCollapsed("pinned")) toggle("pinned");
    pins.put(x, at);
    if (at === undefined) say(t("Pinned “{name}”", { name: nameOf(x) }));
  };
  const unpinThing = (x: Thing) => {
    const e = pinned.find((p) => same(p, x));
    if (!e) return;
    pins.takeAway(e);
    if (view.kind === "search" && same(view.search, x)) go({ kind: "browse", path: "" });
  };
  /** One of the open course's places as it should be. */
  /** `then`: the tab to go to now. */
  const arrangeLayout = (place: Place, next: Shown[], then?: Thing) => {
    if (!courseLayout || layoutId === null) return;
    const id = layoutId;
    keepLayout(id, { ...courseLayout, [place]: next });
    api.arrangeCourse(id, place, next).then((l) => keepLayout(id, l), fail(t("That didn't work")));
    if (then && cv) replaceView(toTab(cv, then));
    // The tab you're on, just hidden or taken away: to the first one. (On a new tab, `tab` is the
    // one before it: nothing to do.)
    else if (place === "tabs" && cv && !cv.blank && listed(courseLayout.tabs, cv.tab) && !listed(next, cv.tab)) replaceView(toTab(cv, firstTab(next, id)));
  };

  /** Mark all as read: for a course, one of its views with a count, a folder; Mark read: a new file
   * (see Things.markRead). */
  const markRead = (x: Thing, count?: number): MenuItem[] => {
    const item = (n: number | undefined, run: () => Promise<unknown>, label = t("Mark all as read")): MenuItem[] =>
      n === 0 ? [] : [{ label, onSelect: () => void run().then(() => (refresh(), seenChanged()), fail(t("Couldn't mark as read"))) }];
    if (x.type === "course") return item(count ?? courseById(x.course)?.new, () => api.markSeen(x.course));
    if (x.type === "view" && countsNew(x.view)) {
      const of = x.view;
      return item(count ?? courseById(x.course)?.new_in[of], () => api.markSeen(x.course, of));
    }
    if (x.type === "folder") return item(count ?? (newFiles?.some((p) => under(p, x.path)) ? undefined : 0), () => api.markPathsSeen([], [x.path]));
    if (x.type === "file") return item(newFiles?.includes(x.path) ? undefined : 0, () => api.markPathsSeen([x.path]), t("Mark read"));
    return [];
  };
  /** Mark read, for several selected: new files, and folders with new files in them. */
  const markSeveralRead = (files: string[], folders: string[] = []): MenuItem[] => {
    const n = files.length + folders.length;
    if (!n) return [];
    return [{ label: tn("Mark 1 item read", "Mark {n} items read", { n }), onSelect: () => void api.markPathsSeen(files, folders).then(() => (refresh(), seenChanged()), fail(t("Couldn't mark as read"))) }];
  };
  /** What can be done with a thing, besides putting it places (they add that). */
  const ways = (x: Thing): MenuItem[] => [...waysOf(x), ...markRead(x)];
  const waysOf = (x: Thing): MenuItem[] => {
    const openIt: MenuItem = { label: t("Open"), onSelect: () => open(x, "", searching ? foundBy() : undefined) };
    switch (x.type) {
      case "course":
        return courseById(x.course) ? [
          openIt,
          { label: t("Open in Canvas"), onSelect: () => void api.openUrl(courseUrl(x.course)) },
          { label: t("Show in {app}", { app: fileManager }), onSelect: () => reveal(courseById(x.course)!.dir) },
        ] : [];
      case "folder":
        return [openIt, { label: t("Show in {app}", { app: fileManager }), onSelect: () => reveal(x.path) }];
      case "file":
        return [
          openIt,
          ...(isMac ? [{ label: t("Quick Look"), onSelect: () => void quickLook([x.path], 0, "open") }] : []),
          { label: t("Show in folder"), onSelect: () => goPath(parentOf(x.path), x.path) },
          { label: t("Show in {app}", { app: fileManager }), onSelect: () => reveal(x.path) },
        ];
      case "doc": {
        if (fromEd(x)) return [openIt, { label: t("Open in Ed"), onSelect: () => void api.item(x.course, x.kind, x.id).then((it) => it.url && api.openUrl(it.url)) }];
        const url = docUrl(x);
        return [openIt, ...(url ? [{ label: t("Open in Canvas"), onSelect: () => void api.openUrl(url) }] : [])];
      }
      default:
        return [openIt];
    }
  };
  const things: Things = {
    courses: courseList, open, openIn, opening, ways, markRead, isPinned,
    showInFolder: (path) => goPath(parentOf(path), path),
    pin: (x) => pinThing(x),
    unpin: unpinThing,
    menu: openMenu,
  };
  const pinOf = (x: Shown): MenuItem => pinItem(things, x);
  const moveItems = (x: Shown): MenuItem[] => {
    const i = pinned.findIndex((p) => same(p, x));
    return [
      { label: t("Move up"), disabled: i <= 0, onSelect: () => pins.move(i, i - 1) },
      { label: t("Move down"), disabled: i >= pinned.length - 1, onSelect: () => pins.move(i, i + 1) },
    ];
  };

  /** What the app calls a course, or a term: changed here at once. The folders stay as they are. */
  const saveTitle = (saved: Promise<unknown>) => saved.then(refresh, (e) => {
    fail(t("Couldn't rename"))(e);
    refresh();
  });
  const renameCourse = (c: Course, title: string) => {
    setCourseList((list) => list.map((x) => (x.id === c.id ? { ...x, label: title || x.display_code, renamed: !!title && title !== x.display_code } : x)));
    void saveTitle(api.setCourseTitle(c.id, title));
  };
  const renameTerm = (key: string, title: string) => {
    setCourseList((list) => list.map((x) => ((x.term ?? "") === key ? { ...x, term_label: title || x.term } : x)));
    void saveTitle(api.setTermTitle(key, title));
  };

  /** What the app calls a folder ("": its own name). */
  const renameFolder = async (path: string, name: string) => {
    setRenaming(null);
    try {
      await api.rename(path, name);
      refresh();
    } catch (e) {
      fail(t("Couldn't rename"))(e);
    }
  };

  const askDelete = (paths: string[], names: string[]) => paths.length > 0 && setDeleting({ paths, label: countLabel(names) });
  const untrack = (paths: string[], names: string[]) =>
    api.untrack(paths).then(() => {
      say(t("Stopped syncing {what}. The files stay where they are.", { what: countLabel(names) }));
      refresh();
    }, fail(t("Couldn't stop syncing")));
  const track = (paths: string[], names: string[]) =>
    api.track(paths).then(() => {
      say(t("Syncing {what} again", { what: countLabel(names) }));
      refresh();
      void startSync({ paths }, countLabel(names));
    }, fail(t("Couldn't resume syncing")));
  const deleteItem = (e: Entry): MenuItem => ({
    label: t("Move to {trash}…", { trash: trashName }), hint: shortcut.delete, danger: true, disabled: syncBusy, onSelect: () => askDelete([e.path], [e.name]),
  });
  const restoreScope = (e: Entry): Scope => (e.type === "dir" ? { paths: [e.path] } : { file_ids: [e.file_id!] });
  /** Not synced: a file you stopped syncing, or anything in a folder you stopped syncing. */
  const notSynced = (e: Entry) => e.skipped || e.states.includes("untracked");
  /** What can stop syncing: folders (one you deleted, too: what Canvas adds to it later), and
   * files from Canvas that are still here. */
  const canStop = (e: Entry) => !notSynced(e) && (e.type === "dir" || (!e.deleted && e.file_id !== null));

  const entryMenu = (e: Entry): MenuItem[] => {
    if (e.deleted) {
      return [
        { label: t("Restore…"), onSelect: () => setRestoring({ scope: restoreScope(e), label: e.name }) },
        ...(e.url ? [{ label: t("Open in Canvas"), onSelect: () => void api.openUrl(e.url!) }] : []),
        ...(e.type === "dir"
          ? ["separator" as const, e.skipped
            ? { label: t("Sync again"), disabled: syncBusy, onSelect: () => void track([e.path], [e.name]) }
            : { label: t("Stop syncing"), disabled: syncBusy, onSelect: () => void untrack([e.path], [e.name]) }]
          : []),
      ];
    }
    if (e.type === "dir") {
      return [
        { label: t("Open"), hint: shortcut.open, onSelect: () => goFolder(e.path) },
        { label: t("Show in {app}", { app: fileManager }), onSelect: () => reveal(e.path) },
        ...markRead({ type: "folder", path: e.path }, e.new_inside),
        "separator",
        pinOf(thingOfEntry(e, courseList)), // (a course's own folder, seen in All files: the course)
        copyItem([e.path], [e.name]),
        { label: t("Rename"), hint: shortcut.rename, onSelect: () => setRenaming(e.path) },
        ...(e.renamed_from ? [{ label: t("Restore original name"), onSelect: () => void renameFolder(e.path, "") }] : []),
        "separator",
        ...(e.skipped ? [] : [{ label: t("Sync now"), disabled: syncBusy, onSelect: () => startSync({ paths: [e.path] }, e.name) }]),
        ...(e.changes ? [{ label: t("Restore originals…"), onSelect: () => setRestoring({ scope: { paths: [e.path] }, label: e.name }) }] : []),
        e.skipped
          ? { label: t("Sync again"), disabled: syncBusy, onSelect: () => void track([e.path], [e.name]) }
          : { label: t("Stop syncing"), disabled: syncBusy, onSelect: () => void untrack([e.path], [e.name]) },
        "separator",
        deleteItem(e),
      ];
    }
    const items: MenuItem[] = [
      { label: t("Open"), hint: shortcut.open, onSelect: () => void api.openPath(e.path) },
      ...(isMac ? [{ label: t("Quick Look"), hint: shortcut.preview, onSelect: () => void quickLook([e.path], 0, "open") }] : []),
      { label: t("Show in {app}", { app: fileManager }), onSelect: () => reveal(e.path) },
      ...markRead({ type: "file", path: e.path }),
    ];
    if (e.url) items.push({ label: t("Open in Canvas"), onSelect: () => void api.openUrl(e.url!) });
    if (e.link) items.push({ label: t("Show original file"), onSelect: () => goPath(parentOf(e.link!), e.link!) });
    items.push("separator", pinOf({ type: "file", path: e.path }), copyItem([e.path], [e.name]));
    if (notSynced(e)) {
      items.push("separator", { label: t("Sync again"), disabled: syncBusy, onSelect: () => void track([e.path], [e.name]) });
    } else if (e.file_id !== null) {
      items.push(
        "separator",
        { label: t("Sync now"), disabled: syncBusy, onSelect: () => startSync({ file_ids: [e.file_id!] }, e.name) },
        ...(e.states.includes("modified") ? [{ label: t("Restore original…"), onSelect: () => setRestoring({ scope: { file_ids: [e.file_id!] }, label: e.name }) }] : []),
        { label: t("Stop syncing"), disabled: syncBusy, onSelect: () => void untrack([e.path], [e.name]) },
      );
    }
    items.push("separator", deleteItem(e));
    return items;
  };

  /** Right-clicking a selection of several. */
  /** The folder showing, right-clicked where nothing is: what's shown, and what to do with it. */
  const folderMenu = (here: string): MenuItem[] => {
    const label = course && here === course.dir ? course.label : here ? folderTitle(here) : t("All files");
    return sections(
      [{ label: t("Show modifications"), checked: showChanges, hint: shortcut.toggleChanges || undefined, onSelect: () => setShowChanges(!showChanges) }],
      [
        { label: t("Sync now"), disabled: syncBusy, onSelect: () => (here ? startSync({ paths: [here] }, label) : startSync({}, t("All courses"))) },
        { label: t("Restore originals…"), onSelect: () => setRestoring({ scope: { paths: [here] }, label }) },
        { label: t("Show in {app}", { app: fileManager }), onSelect: () => void api.openPath(here, { reveal: here !== "" }) },
      ],
      course ? [{ label: t("Open in Canvas"), onSelect: () => void api.openUrl(courseUrl(course.id)) }] : [],
    );
  };
  const entriesMenu = (es: Entry[]): MenuItem[] => {
    if (es.length === 1) return entryMenu(es[0]);
    const live = es.filter((e) => !e.deleted);
    const files = live.filter((e) => e.type === "file");
    const synced = live.filter((e) => !notSynced(e) && (e.type === "dir" || e.file_id !== null));
    const resume = es.filter((e) => notSynced(e) && (e.type === "dir" || !e.deleted));
    const stop = es.filter(canStop);
    const label = countLabel(es.map((e) => e.name));
    const scope: Scope = {
      paths: es.filter((e) => e.type === "dir").map((e) => e.path),
      file_ids: es.filter((e) => e.type === "file" && e.file_id !== null).map((e) => e.file_id!),
    };
    return [
      { label: tn("Open 1 file", "Open {n} files", { n: files.length }), disabled: !files.length, onSelect: () => files.slice(0, 20).forEach((f) => void api.openPath(f.path)) },
      ...markSeveralRead(files.filter((e) => e.new).map((e) => e.path), live.filter((e) => e.type === "dir" && e.new_inside > 0).map((e) => e.path)),
      "separator",
      { ...copyItem(live.map((e) => e.path), live.map((e) => e.name)), disabled: !live.length },
      "separator",
      ...(synced.length ? [{ label: t("Sync now"), disabled: syncBusy, onSelect: () => startSync(scope, label) }] : []),
      { label: t("Restore originals…"), onSelect: () => setRestoring({ scope, label }) },
      ...(resume.length
        ? [{ label: t("Sync again"), disabled: syncBusy, onSelect: () => void track(resume.map((e) => e.path), resume.map((e) => e.name)) }]
        : []),
      ...(stop.length
        ? [{ label: t("Stop syncing"), disabled: syncBusy, onSelect: () => void untrack(stop.map((e) => e.path), stop.map((e) => e.name)) }]
        : []),
      "separator",
      {
        label: t("Move {what} to {trash}…", { what: countLabel(live.map((e) => e.name)), trash: trashName }), hint: shortcut.delete, danger: true, disabled: syncBusy || !live.length,
        onSelect: () => askDelete(live.map((e) => e.path), live.map((e) => e.name)),
      },
    ];
  };

  const hitsMenu = (hs: Hit[]): MenuItem[] => {
    const onDisk = hs.filter((h) => h.path);
    const del: MenuItem = {
      label: hs.length > 1 ? tn("Move 1 file to {trash}…", "Move {n} files to {trash}…", { n: onDisk.length, trash: trashName }) : t("Move to {trash}…", { trash: trashName }), hint: shortcut.delete, danger: true, disabled: syncBusy || !onDisk.length,
      onSelect: () => askDelete(onDisk.map((h) => h.path!), onDisk.map((h) => h.title)),
    };
    if (hs.length > 1) {
      return [
        { label: tn("Open 1 item", "Open {n} items", { n: hs.length }), onSelect: () => hs.slice(0, 20).forEach(openHere) },
        ...markSeveralRead(onDisk.map((h) => h.path!).filter((p) => newFiles?.includes(p))),
        "separator",
        { ...copyItem(onDisk.map((h) => h.path!), onDisk.map((h) => h.title)), disabled: !onDisk.length },
        "separator",
        del,
      ];
    }
    const h = hs[0];
    const x = thingOfHit(h);
    return [
      { label: t("Open"), hint: shortcut.open, onSelect: () => openHere(h) },
      ...(h.path && isMac ? [{ label: t("Quick Look"), hint: shortcut.preview, onSelect: () => void quickLook([h.path!], 0, "open") }] : []),
      ...(h.path
        ? [
            { label: t("Show in folder"), onSelect: () => goPath(parentOf(h.path!), h.path!, foundBy(h)) },
            { label: t("Show in {app}", { app: fileManager }), onSelect: () => reveal(h.path!) },
          ]
        : []),
      ...(h.url ? [{ label: onTheWeb(h.url), onSelect: () => void api.openUrl(h.url!) }] : []),
      ...(h.path ? markRead({ type: "file", path: h.path }) : []),
      ...(x || h.path ? ["separator" as const] : []),
      ...(x ? [pinOf({ ...x, name: h.title })] : []),
      ...(h.path ? [copyItem([h.path], [h.title])] : []),
      ...(h.path ? ["separator" as const, del] : []),
    ];
  };
  /** Right-clicking what search found only in the index (a thing has its own menu: useThing). */
  const hitMenu = (f: Found) =>
    f.type === "hit" ? { onContextMenu: (ev: React.MouseEvent) => (ev.preventDefault(), openMenu(hitsMenu([f.hit]), ev.clientX, ev.clientY)) } : {};

  const unhide = (c: Course) =>
    api.hideCourse(c.id, false, c.excluded ? true : undefined).then(async () => {
      refresh();
      const synced = c.excluded && (await startSync({ paths: [c.dir] }, c.label));
      say(c.excluded && !synced ? t("“{name}” is back, and updates on the next sync", { name: c.label }) : t("“{name}” is back", { name: c.label }));
    }, fail(t("That didn't work")));
  /** A hidden term back, synced again: its courses each as they were before hiding. */
  const unhideTerm = (term: string, list: Course[]) =>
    api.hideCourses(list.map((c) => c.id), false, list.some((c) => c.excluded) ? true : undefined).then(() => {
      say(t("“{name}” is back", { name: term }));
      refresh();
      const excluded = list.filter((c) => c.excluded);
      if (excluded.length) void startSync({ paths: excluded.map((c) => c.dir) }, term);
    }, fail(t("That didn't work")));
  const hiddenCourseMenu = (c: Course): MenuItem[] => [
    { label: t("Open"), onSelect: () => openCourse(c) },
    { label: t("Open in Canvas"), onSelect: () => void api.openUrl(courseUrl(c.id)) },
    "separator",
    { label: c.excluded ? t("Unhide and sync again") : t("Unhide"), onSelect: () => void unhide(c) },
  ];
  /** `row`: which row of the sidebar this is the menu of, where renaming happens. */
  const courseMenu = (c: Course, row = `course:${c.id}`): MenuItem[] => [
    { label: t("Open"), onSelect: () => openCourse(c) },
    ...markRead({ type: "course", course: c.id }),
    { label: t("View files"), onSelect: () => go({ kind: "course", id: c.id, tab: viewOf(c.id, "files"), path: c.dir }) },
    { label: t("Open in Canvas"), onSelect: () => void api.openUrl(courseUrl(c.id)) },
    { label: t("Show in {app}", { app: fileManager }), onSelect: () => reveal(c.dir) },
    "separator",
    { label: t("Sync now"), disabled: syncBusy, onSelect: () => startSync({ paths: [c.dir] }, c.label) },
    ...(changes[c.id] ? [{ label: t("Restore originals…"), onSelect: () => setRestoring({ scope: { paths: [c.dir] }, label: c.label }) }] : []),
    "separator",
    pinOf({ type: "course", course: c.id }),
    { label: t("Rename"), onSelect: () => setRenamingHere(row) },
    ...(c.renamed ? [{ label: t("Restore original name"), onSelect: () => renameCourse(c, "") }] : []),
    { label: t("Change icon…"), onSelect: () => setChoosingIcon(c) },
    { label: t("New smart folder…"), onSelect: () => setEditing({ folder: null, preset: { courses: [c.id] } }) },
    "separator",
    { label: t("Hide…"), onSelect: () => setHiding({ courses: [c] }) },
  ];

  const termMenu = (key: string, term: string, list: Course[]): MenuItem[] => {
    return [
      { label: t("Sync now"), disabled: syncBusy, onSelect: () => startSync({ paths: list.map((c) => c.dir) }, term) },
      ...(list.some((c) => changes[c.id]) ? [{ label: t("Restore originals…"), onSelect: () => setRestoring({ scope: { paths: list.map((c) => c.dir) }, label: term }) }] : []),
      "separator",
      { label: t("Rename"), onSelect: () => setRenamingHere(`term:${key}`) },
      ...(list[0].term_label !== list[0].term
        ? [{ label: t("Restore original name"), onSelect: () => renameTerm(key, "") }]
        : []),
      "separator",
      { label: t("Hide…"), onSelect: () => setHiding({ courses: list, term }) },
    ];
  };

  /** Something pinned: what can be done with it, then renaming, moving and unpinning it. (A course
   * has its own menu; a smart folder is edited, and deleted when unpinned.) */
  const pinnedMenu = (x: Shown): MenuItem[] => {
    const c = x.type === "course" ? courseById(x.course) : null;
    if (c) return sections(courseMenu(c, `pin:${thingKey(x)}`), moveItems(x));
    return sections(
      x.exists === false ? [] : ways(x),
      x.type === "search" ? [{ label: t("Edit…"), onSelect: () => setEditing({ folder: { ...x, title: x.title ?? "" } }) }] : [],
      [
        { label: t("Rename"), onSelect: () => setRenamingHere(`pin:${thingKey(x)}`) },
        ...(x.title && x.type !== "search" ? [{ label: t("Restore original name"), onSelect: () => pins.rename(x, "") }] : []),
      ],
      moveItems(x),
      [x.type === "search"
        ? { label: t("Delete smart folder"), danger: true, onSelect: () => unpinThing(x) }
        : { label: t("Unpin"), onSelect: () => unpinThing(x) }],
    );
  };

  /** What's showing here, as a thing: to pin it from Pinned's +. */
  const shownThing: Shown | null = cv && course
    ? filesTab ? (cv.path === course.dir ? { type: "course", course: course.id } : { type: "folder", path: cv.path })
      : cv.blank || isView(tab, "overview") ? { type: "course", course: course.id } : tabEntry
    : view.kind === "browse" && view.path ? { type: "folder", path: view.path } : null;
  const addMenu = (): MenuItem[] => [
    { label: t("New smart folder…"), onSelect: () => setEditing({ folder: null }) },
    ...(shownThing && !isPinned(shownThing)
      ? [{ label: t("Pin “{name}”", { name: shownThing.type === "folder" ? folderTitle(shownThing.path) : nameOf(shownThing) }), onSelect: () => pinThing(shownThing) }]
      : []),
  ];

  // -- arranging the sidebar: drag pinned items, courses within a term, terms; fold sections -----
  const groups = useMemo(() => arrange(courseList.filter((c) => !c.hidden), order), [courseList, order]);
  const hiddenCourses = courseList.filter((c) => c.hidden);
  onKey.current = (e: KeyboardEvent) => {
    const command = appCommand(e, typingIn(e.target));
    if (command === "back") step(-1);
    else if (command === "forward") step(1);
    else if (command === "search" && searchBox.current) searchBox.current.focus();
    else if (command === "search") void showLauncher(); // a page without a box: the search window
    else if (command === "toggleChanges") setShowChanges(!showChanges);
    else if (command === "settings") go({ kind: "settings" });
    else if (command === "sync") void (syncBusy || startSync({}, t("All courses")));
    else if (command === "prevCourse" || command === "nextCourse") {
      // The sidebar's courses, in its order; from elsewhere, the first or the last.
      const list = groups.flatMap((g) => g.courses);
      const i = list.findIndex((c) => c.id === cv?.id);
      const next = command === "nextCourse" ? (i < 0 ? list[0] : list[i + 1]) : (i < 0 ? list.at(-1) : list[i - 1]);
      if (next) openCourse(next);
    } else if (command === "shortcuts") setShowingKeys(true);
    else return;
    e.preventDefault();
  };
  const saveOrder = (next: Partial<SidebarOrder>) => {
    setOrder((o) => ({ ...o, ...next }));
    api.arrangeSidebar(next).then(setOrder, fail(t("Couldn't move")));
  };
  const termDrag = useReorder(groups.length, (from, to) => saveOrder({ terms: moved(groups.map((g) => g.key), from, to) }));
  /** One term's courses in a new order; every course gets its place, so the rest stay put. */
  const reorderTerm = (key: string, ids: number[]) =>
    saveOrder({ courses: groups.flatMap((g) => (g.key === key ? ids : g.courses.map((c) => c.id))) });
  const isCollapsed = (section: string) => collapsed.includes(section);
  const toggle = (section: string) => setCollapsed(isCollapsed(section) ? collapsed.filter((s) => s !== section) : [...collapsed, section]);

  if (startupError) return <StartupError message={startupError} />;

  // -- layout ---------------------------------------------------------------------------
  const showing = (x: Thing) => isShowing(view, x); // (what's on screen: highlighted in Pinned)
  const pinnedHere = pinned.some(showing); // highlight that, not also its course
  /** The sidebar's row `row`, if it's the one being renamed: its name, as an input. */
  const nameEditor = (row: string, initial: string, submit: (name: string) => void, hint?: string, className = "h-5 text-sm") =>
    renamingHere !== row ? undefined : (
      <RenameInput initial={initial} hint={hint} onCancel={() => setRenamingHere(null)} className={`block w-full ${className}`}
        onSubmit={(name) => {
          setRenamingHere(null);
          submit(name);
        }} />
    );
  const titleHint = t("Only the name in the app changes; its folder and syncing aren't affected.");
  const renderPinned = (x: Shown) => {
    const c = x.type === "course" ? courseById(x.course) : null;
    const inCourse = x.in_course != null ? courseById(x.in_course)
      : "course" in x ? courseById(x.course) : x.type === "folder" || x.type === "file" ? courseAt(x.path) : null; // (just pinned)
    const gone = x.exists === false;
    const where = x.type === "course" ? (c ? (c.term_label ?? undefined) : t("This course is gone"))
      : x.type === "folder" ? (gone ? t("This folder is gone") : pinnedWhere(x.path, inCourse))
        : x.type === "file" ? (gone ? t("This file isn't there any more") : pinnedWhere(x.path, inCourse))
          : x.type === "link" ? ownName({ ...x, title: "" }, courseList)
            : x.type === "search" ? undefined
              : opening === thingKey(x) ? t("Opening…") : gone ? t("No longer on Canvas") : inCourse?.label ?? t("This course is gone");
    return (
      <NavItem
        icon={<ThingIcon thing={x} courses={courseList} />}
        title={nameOf(x)}
        editor={c
          ? nameEditor(`pin:${thingKey(x)}`, c.label, (name) => renameCourse(c, name), titleHint)
          : nameEditor(`pin:${thingKey(x)}`, nameOf(x), (title) => pins.rename(x, title))}
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
    if (cv.blank) {
      return (
        <NewTab course={course} overview={overview} entries={tabs} typing={searching} found={foundHere}
          box={<SearchInput inputRef={searchBox} value={query} onChange={setQuery} placeholder={searchPlaceholder} completion={query ? completing : null} autoFocus />}
          onOpen={(next, x) => {
            intoNewTab(x);
            arrangeLayout("tabs", next, x);
          }}
          onShow={(x) => {
            intoNewTab(x);
            replaceView(toTab(cv, x));
          }} />
      );
    }
    if (isView(tab, "overview")) {
      return (
        <CourseOverview
          key={course.id} // (each course's cards are placed afresh, not slid from the last course's places)
          course={course}
          overview={overview}
          cards={courseLayout?.overview ?? null}
          links={courseLayout?.links ?? []}
          onArrange={arrangeLayout}
          onSay={say}
          onMarkSeen={(of) => void api.markSeen(course.id, of).then(refresh, fail(t("Couldn't mark as read")))}
        />
      );
    }
    if (isView(tab, "modules") || tab.type === "module") {
      return (
        <CourseModules
          key={`${course.id}:${thingKey(tab)}`}
          course={course}
          focus={cv.item ? Number(cv.item) : undefined}
          only={tab.type === "module" ? tab.module : undefined}
          box={box}
        />
      );
    }
    if (isView(tab, "grades")) {
      return <CourseGrades key={course.id} course={course} box={box} />;
    }
    if (isView(tab, "tools")) {
      return (
        <LinksPage course={course} links={courseLayout?.links ?? []} syllabus={!!overview?.counts.syllabus}
          onArrange={(next) => arrangeLayout("links", next)} onSay={say} />
      );
    }
    if (isView(tab) && VIEW_LISTS[tab.view]) {
      return (
        <CourseReader
          course={course}
          of={VIEW_LISTS[tab.view]!}
          selected={cv.item ?? null}
          onSelect={(id) => replaceView({ ...cv, item: id, found: undefined })}
          onSeen={seenChanged}
          box={box}
        />
      );
    }
    if (tab.type === "doc") return <CourseDoc course={course} kind={tab.kind} id={tab.id} onSeen={seenChanged} />;
    if (tab.type === "note") return <NoteEditor key={thingKey(tab)} course={course.id} id={tab.id} page />;
    if (tab.type === "search") return null; // (its results: below)
    return (
      <FileBrowser
        path={cv.path === inlineOf(course, tab) ? course.dir : cv.path}
        root={course.dir}
        inline={inlineOf(course, tab)}
        missing={course.excluded ? t("This course isn't synced, so there are no files here.") : t("This course has no files yet. Once it has some on Canvas, they appear here after a sync.")}
        marked={isView(tab, "files") ? sourceMarks(course) : undefined}
        select={cv.select}
        mode={mode}
        showChanges={showChanges}
        onNavigate={goPath}
        onOpen={(e) => (e.deleted ? setRestoring({ scope: restoreScope(e), label: e.name }) : void api.openPath(e.path).then(seenChanged))}
        onMenu={(es, x, y) => openMenu(entriesMenu(es), x, y)}
        onFolderMenu={(x, y) => openMenu(folderMenu(cv.path), x, y)}
        onDelete={(es) => {
          const live = es.filter((e) => !e.deleted);
          if (!syncBusy) askDelete(live.map((e) => e.path), live.map((e) => e.name));
        }}
        onCopy={(es) => copy(es.map((e) => e.path), es.map((e) => e.name))}
        renaming={renaming}
        onStartRename={(e) => canRename(e) && setRenaming(e.path)}
        onRename={(e, name) => void renameFolder(e.path, name)}
        onRenameCancel={() => setRenaming(null)}
      />
    );
  };
  const foundHere = (
    <FoundHere box={searchBox} query={query} onQuery={setQuery} scope={scope} finder={finder} actions={actions} onOpen={openFound} props={hitMenu} onCompletion={setCompleting} hover={!!cv?.blank}
      note={scopeNote && (
        <span className="flex items-center gap-2">
          {scopeNote.text}
          <button onClick={scopeNote.onAction} className="text-accent hover:underline">{scopeNote.action}</button>
        </span>
      )} />
  );
  const page = cv && course && tab && (!searching || cv.blank) ? coursePage(cv, course, tab) : null; // (a new tab searches in itself)
  const markedPlace = cv ? `${cv.id}:${tab ? thingKey(tab) : ""}:${cv.item ?? ""}:${cv.path}` : view.kind === "browse" ? view.path : view.kind === "search" ? thingKey(view.search) : "";

  return (
    <ThingsContext.Provider value={things}>
    <FinderContext.Provider value={finder}>
    <div className="flex h-screen bg-bg text-fg">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-sidebar">
        {/* The title bar: the window controls (macOS), then the sync button. Empty space drags the window. */}
        <div data-tauri-drag-region="deep" className={`flex h-13 shrink-0 items-center justify-end pr-3 ${trafficLights ? "pl-20" : "pl-4"}`}>
          <button
            onClick={() => startSync({}, t("All courses"))}
            disabled={syncBusy}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-soft hover:bg-chip disabled:opacity-60"
            title={`${t("Get what's new in every course from Canvas")} (${shortcut.sync})`}
          >
            <RefreshCw className={`size-3.5 ${syncBusy ? "animate-spin" : ""}`} aria-hidden />
            {t("Sync")}
          </button>
        </div>
        {signedOut ? (
          <button onClick={() => setSigningIn(true)} className="mx-4 mb-2 rounded-md bg-warn-soft px-2.5 py-2 text-left text-xs text-warn hover:opacity-90">
            {t("Not signed in to Canvas, so nothing syncs. Click to sign in.")}
          </button>
        ) : (
          <SyncStatus sync={sync} label={syncLabel} onFix={() => go({ kind: "settings" })}
            session={account?.auth === "session"} renewing={renewing}
            onSignIn={() => setSigningIn(true)} />
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <NavItem icon={<Search className="size-4" />} active={false} onPress={pressSearchButton} onClick={clickSearchButton} title={t("Search")} keys={keysLabel(launcherKeys)} />
          <NavItem icon={<FolderTree className="size-4" />} active={view.kind === "browse" && view.path === ""} onClick={() => go({ kind: "browse", path: "" })} title={t("All files")} />

          <PinnedSection
            place={pins}
            collapsed={isCollapsed("pinned")}
            header={
              <SectionHeader
                title={t("Pinned")}
                collapsed={isCollapsed("pinned")}
                onToggle={() => toggle("pinned")}
                action={{ label: t("Add to pinned"), icon: <Plus className="size-3.5" />, onClick: (x, y) => openMenu(addMenu(), x, y) }}
              />
            }
            empty={
              <p className="px-2 py-1 text-xs leading-relaxed text-muted">
                {t("Drag courses, folders, files, announcements, pages, tools or tabs here.")}
              </p>
            }
            render={renderPinned}
            onPin={(x, at) => pinThing(x, at)}
            onUnpin={(x) => unpinThing(x)}
          />

          {courseList.length === 0 && !signedOut && (
            <p className="px-2 py-3 text-xs leading-relaxed text-muted">{sync?.running ? t("Syncing for the first time; your courses will show up here shortly.") : t("No courses yet. Click “Sync” above to get them from Canvas.")}</p>
          )}
          {groups.map((g, i) => (
            <TermSection
              key={g.key}
              group={g}
              sectionRef={termDrag.ref(i)}
              grab={termDrag.handle(i)}
              collapsed={isCollapsed(`term:${g.key}`)}
              onToggle={() => toggle(`term:${g.key}`)}
              onMenu={(x, y) => openMenu(termMenu(g.key, g.label, g.courses), x, y)}
              editor={nameEditor(`term:${g.key}`, g.label, (name) => renameTerm(g.key, name), titleHint, "h-[18px] text-[11px] font-medium")}
              onReorder={(ids) => reorderTerm(g.key, ids)}
              renderCourse={(c) => (
                <NavItem
                  icon={<CourseIcon course={c} />}
                  title={c.label}
                  editor={nameEditor(`course:${c.id}`, c.label, (name) => renameCourse(c, name), titleHint)}
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
                title={t("Hidden courses")}
                collapsed={!hiddenOpen}
                onToggle={() => setHiddenOpen(!hiddenOpen)}
              />
              {hiddenOpen && groupByTerm(hiddenCourses).map(({ key, label: term, courses: list }) => (
                <div key={key}>
                  <p
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu([{ label: t("Unhide the whole term"), onSelect: () => void unhideTerm(term, list) }], e.clientX, e.clientY);
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
                      subtitle={c.excluded ? t("Not synced") : undefined}
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
          <UpdateNotice />
          <NavItem icon={<SettingsIcon className="size-4" />} active={view.kind === "settings"} onClick={() => go({ kind: "settings" })} title={t("Settings")} keys={shortcut.settings} />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {/* (On Windows, room at the right end for the window's buttons.) */}
        <header data-tauri-drag-region="deep" className={`flex h-13 shrink-0 items-center gap-2 border-b border-line pl-4 ${ownFrame ? "pr-[146px]" : "pr-4"}`}>
          <div className="flex shrink-0">
            <ToolButton title={t("Back ({back})", { back: shortcut.back })} disabled={hist.i === 0} onClick={() => step(-1)}><ChevronLeft className="size-4" /></ToolButton>
            <ToolButton title={t("Forward ({forward})", { forward: shortcut.forward })} disabled={hist.i === hist.stack.length - 1} onClick={() => step(1)}><ChevronRight className="size-4" /></ToolButton>
          </div>
          <div className="min-w-0 flex-1">
            {view.kind === "browse" && <Breadcrumb path={view.path} onGo={goFolder} />}
            {cv && course && (
              <Breadcrumb
                path={filesTab ? cv.path : course.dir}
                root={{ path: course.dir, label: course.label, icon: <CourseIcon course={course} /> }}
                onRootMenu={(x, y) => openMenu(course.hidden ? hiddenCourseMenu(course) : courseMenu(course), x, y)} // (its sidebar row's)
                inline={inlineOf(course, cv.blank ? null : tab)}
                onGo={(p) => (p === course.dir && !filesTab ? openCourse(course) : goPath(p))}
              />
            )}
            {view.kind === "search" && <SmartTitle folder={view.search} name={folderEntry ? nameOf(folderEntry) : nameOf(view.search)} courses={courseList} />}
            {view.kind === "settings" && <span className="text-sm font-medium">{t("Settings")}</span>}
          </div>
          {view.kind !== "settings" && (
            <>
              {filesView && !cv?.blank && ( // (a new tab has its own box)
                <SearchInput inputRef={searchBox} value={query} onChange={setQuery} placeholder={searchPlaceholder} completion={query ? completing : null} compact />
              )}
              {((filesTab && !searching) || !!smart) && (
                <div className="flex shrink-0 rounded-md border border-line p-0.5">
                  <ToolButton title={t("List")} pressed={mode === "list"} onClick={() => setMode("list")}><List className="size-4" /></ToolButton>
                  <ToolButton title={t("Icons")} pressed={mode === "grid"} onClick={() => setMode("grid")}><LayoutGrid className="size-4" /></ToolButton>
                </div>
              )}
              {filesTab && !searching && (
                <div className="flex shrink-0 rounded-md border border-line p-0.5">
                  <ToolButton
                    title={`${showChanges ? t("Hide modifications") : t("Show modifications")}${shortcut.toggleChanges ? ` (${shortcut.toggleChanges})` : ""}`}
                    pressed={showChanges}
                    onClick={() => setShowChanges(!showChanges)}
                  >{showChanges ? <Eye className="size-4" /> : <EyeOff className="size-4" />}</ToolButton>
                </div>
              )}
              {view.kind === "search" && folderEntry && (
                <Button onClick={() => setEditing({ folder: { ...view.search, title: folderEntry.title ?? "" } })} className="shrink-0 text-xs">{t("Edit")}</Button>
              )}
            </>
          )}
        </header>

        {cv && course && tab && (
          <CourseTabs
            course={course}
            tab={tab}
            blank={!!cv.blank}
            spare={spare}
            overview={overview}
            entries={courseLayout ? tabs : null}
            onArrange={(next) => arrangeLayout("tabs", next)}
            onTab={(x) => go(toTab(cv, x))}
            onNewTab={() => go({ ...cv, blank: true, found: undefined, select: undefined })}
            onCloseSpare={closeSpare}
            onSay={say}
          />
        )}

        <Marked pattern={marking} place={markedPlace} tools={!narrowed} onClear={clearMarks}>
        {view.kind === "settings" ? (
          <Settings
            account={account}
            sync={sync}
            onSync={() => void startSync({}, t("All courses"))}
            onAccount={(a) => (setAccount(a), refresh())}
          />
        ) : page ? (
          page
        ) : view.kind === "browse" && !searching ? (
          <FileBrowser
            path={view.path}
            root=""
            select={view.select}
            mode={mode}
            showChanges={showChanges}
            onNavigate={goFolder}
            onOpen={(e) => (e.deleted ? setRestoring({ scope: restoreScope(e), label: e.name }) : void api.openPath(e.path).then(seenChanged))}
            onMenu={(es, x, y) => openMenu(entriesMenu(es), x, y)}
            onFolderMenu={(x, y) => openMenu(folderMenu(view.path), x, y)}
            onDelete={(es) => {
              const live = es.filter((e) => !e.deleted);
              if (!syncBusy) askDelete(live.map((e) => e.path), live.map((e) => e.name));
            }}
            onCopy={(es) => copy(es.map((e) => e.path), es.map((e) => e.name))}
            renaming={renaming}
            onStartRename={(e) => canRename(e) && setRenaming(e.path)}
            onRename={(e, name) => void renameFolder(e.path, name)}
            onRenameCancel={() => setRenaming(null)}
          />
        ) : searching ? (
          foundHere
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
            onReveal={(h) => h.path && goPath(parentOf(h.path), h.path, foundBy(h))}
            onMenu={(hs, x, y) => openMenu(hitsMenu(hs), x, y)}
            onDelete={(hs) => !syncBusy && askDelete(hs.map((h) => h.path!), hs.map((h) => h.title))}
            onCopy={(hs) => copy(hs.map((h) => h.path!), hs.map((h) => h.title))}
          />
        )}
        </Marked>
      </main>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
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
            say(t("Hid “{name}”", { name: hiding.term ?? hiding.courses[0].label }));
            if (cv && hiding.courses.some((c) => c.id === cv.id)) go({ kind: "browse", path: "" });
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
            say(t("Moved to {trash}: {label}", { trash: trashName, label: deleting.label }));
            setDeleting(null);
            refresh();
          }}
        />
      )}
      {showingKeys && <KeysDialog onClose={() => setShowingKeys(false)} />}
      {signingIn && account && (
        <SignInDialog account={account} onClose={() => setSigningIn(false)} onDone={(a) => {
          setSigningIn(false);
          setAccount(a);
          refresh();
          if (sync?.expired) void runSync(sync.scope.length ? { paths: sync.scope } : {}, syncLabel); // (what failed for it)
        }} />
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
    </FinderContext.Provider>
    </ThingsContext.Provider>
  );
}


export function StartupError({ message }: { message: string }) {
  return (
    <div data-tauri-drag-region className="flex h-screen items-center justify-center bg-bg p-8 text-fg">
      <div className="max-w-lg">
        <h1 className="mb-2 text-lg font-semibold">{t("The background service didn't start")}</h1>
        <pre className="overflow-auto rounded-md bg-chip p-3 text-xs whitespace-pre-wrap text-danger">{message}</pre>
      </div>
    </div>
  );
}
