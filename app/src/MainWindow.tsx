import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronLeft, ChevronRight, Eye, EyeOff, Folder, FolderTree, GraduationCap, LayoutGrid, List, MoreHorizontal, Plus, RefreshCw, Search,
  Settings as SettingsIcon, Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./components/Dialog";
import { FileBrowser, canRename, parentOf, type ViewMode } from "./components/FileBrowser";
import {
  CourseGrades, CourseModules, CourseOverview, CourseReader, CourseTabs, TAB_OF_KIND, arrangeCards, arrangeTabs, useOverview,
  type CourseTab, type OverviewCard,
} from "./components/CourseView";
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
import { SmartFolderDialog } from "./components/SmartFolderDialog";
import * as api from "./lib/api";
import type { AccountInfo, Course, DocKind, Entry, Hit, Kind, PinnedItem, Scope, SidebarOrder, SmartFolder, SyncState } from "./lib/api";
import { appCommand, fileManager, isMac, shortcut, trashName } from "./lib/keys";
import { usePref } from "./lib/prefs";
import { useSearch } from "./lib/useSearch";
import { CourseIcon } from "./lib/courseIcons";
import { DropMark, moved, useReorder, type Mark } from "./lib/reorder";
import { useTrafficLights } from "./lib/window";
import { friendly } from "./lib/errors";
import { t, tx } from "./lib/i18n";

// A course is its own kind of place, not "a folder": it opens on an overview, with tabs for
// its announcements, assignments, files, syllabus and pages. `path` is the folder the 文件
// tab is in; `item` the announcement / assignment / page being read.
type View =
  | { kind: "home" }
  | { kind: "course"; id: number; tab: CourseTab; path: string; select?: string; item?: string }
  | { kind: "browse"; path: string; select?: string }
  | { kind: "smart"; name: string }
  | { kind: "settings" };

const SEASON: Record<string, number> = { winter: 0, spring: 1, summer: 2, fall: 3, autumn: 3 };

/** "Fall 2026" > "Summer 2026" > "Spring 2026" > ... ; terms without a year last. */
function termRank(term: string | null): number {
  const t = (term ?? "").toLowerCase();
  const year = Number(t.match(/\b(20\d\d)\b/)?.[1] ?? 0);
  const season = Object.entries(SEASON).find(([s]) => t.includes(s))?.[1] ?? -1;
  return year * 10 + season;
}

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

export function MainWindow() {
  const [courseList, setCourseList] = useState<Course[]>([]);
  const [pinned, setPinned] = useState<PinnedItem[]>([]);
  const [hist, setHist] = useState<{ stack: View[]; i: number }>({ stack: [{ kind: "home" }], i: 0 });
  const [query, setQuery] = useState("");
  const [mode, setMode] = usePref<ViewMode>("viewMode", "list");
  const [showDeleted, setShowDeleted] = usePref("showDeleted", false);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [order, setOrder] = useState<SidebarOrder>({ terms: [], courses: [] });
  const [collapsed, setCollapsed] = usePref<string[]>("sidebar-collapsed", []); // "pinned", "term:<term>"
  const [hiddenOpen, setHiddenOpen] = usePref("sidebar-hidden-open", false); // the hidden courses, folded at first
  const [hiding, setHiding] = useState<Course | null>(null);
  const [choosingIcon, setChoosingIcon] = useState<Course | null>(null);
  const [tabs, setTabs] = useState<{ order: CourseTab[]; hidden: CourseTab[] }>({ order: arrangeTabs([]), hidden: [] });
  const [cards, setCards] = useState<{ order: OverviewCard[]; hidden: OverviewCard[] }>({ order: arrangeCards([]), hidden: [] });
  const [syncLabel, setSyncLabel] = useState("");
  const [changes, setChanges] = useState<Record<number, number>>({});
  const [version, setVersion] = useState(0);
  const [seenTick, setSeenTick] = useState(0); // you opened something: what's new changed
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [restoring, setRestoring] = useState<{ scope: Scope; label: string } | null>(null);
  const [deleting, setDeleting] = useState<{ paths: string[]; label: string } | null>(null);
  const [editing, setEditing] = useState<{ folder: SmartFolder | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null); // a folder being renamed in place
  const [renameDialog, setRenameDialog] = useState<{ path: string; title: string; current: string; hint?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const trafficLights = useTrafficLights();

  const view = hist.stack[hist.i];
  const go = useCallback((v: View) => {
    setQuery("");
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
  useEffect(() => {
    void api.prefs().then((p) => {
      setTabs({ order: arrangeTabs(p.tab_order ?? []), hidden: (p.hidden_tabs ?? []) as CourseTab[] });
      setCards({ order: arrangeCards(p.overview_order ?? []), hidden: (p.overview_hidden ?? []) as OverviewCard[] });
    }, () => {});
  }, []);
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

  // Window-wide keys (back, forward, search, show deleted), per platform; and the mouse's
  // back / forward buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = appCommand(e, typingIn(e.target));
      if (command === "back") step(-1);
      else if (command === "forward") step(1);
      else if (command === "search") searchBox.current?.focus();
      else if (command === "toggleDeleted") setShowDeleted(!showDeleted);
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
  }, [showDeleted]);

  // -- where we are ---------------------------------------------------------------------
  const filesView = view.kind === "browse" || view.kind === "course"; // has a search box for where it is
  const filesTab = view.kind === "browse" || (view.kind === "course" && view.tab === "files");
  const browsing = filesView ? view.path : null;
  const course = view.kind === "course" ? courseList.find((c) => c.id === view.id) ?? null : null;
  const courseAt = (path: string) => courseList.find((c) => under(path, c.dir)) ?? null;
  /** Go to a folder: inside a course, that's the course's page; elsewhere, a plain folder. */
  const goPath = (path: string, select?: string) => {
    const c = courseAt(path);
    go(c ? { kind: "course", id: c.id, tab: "files", path, select } : { kind: "browse", path, select });
  };
  /** The tab a course opens on: 概览, unless you hid it (then your first tab). */
  const firstTab = tabs.order.find((x) => !tabs.hidden.includes(x)) ?? "overview";
  const openCourse = (c: Course, tab: CourseTab = firstTab) => go({ kind: "course", id: c.id, tab, path: c.dir });
  const arrangeCourseTabs = (order: CourseTab[], hidden: CourseTab[]) => {
    setTabs({ order, hidden });
    void api.setPrefs({ tab_order: order, hidden_tabs: hidden }).catch(fail(t("操作失败")));
    // Hid the tab you're on: go to the first one left.
    if (view.kind === "course" && hidden.includes(view.tab)) {
      replaceView({ ...view, tab: order.find((x) => !hidden.includes(x)) ?? "overview", item: undefined });
    }
  };
  /** An announcement, assignment, page or the syllabus, shown in its course's page. */
  const openDoc = (courseId: number, kind: DocKind, id: string) => {
    const c = courseList.find((x) => x.id === courseId);
    go({ kind: "course", id: courseId, tab: TAB_OF_KIND[kind], path: c?.dir ?? "", item: kind === "syllabus" ? undefined : id });
  };
  const openHere = (h: Hit) =>
    h.kind !== "file" && h.doc_id ? openDoc(h.course_id, h.kind as DocKind, h.doc_id) : void api.openHit(h);
  const overview = useOverview(view.kind === "course" ? view.id : null, version, seenTick);

  // The search window asks us to show an announcement / assignment / page.
  const openDocLater = useRef(openDoc);
  openDocLater.current = openDoc;
  useEffect(() => {
    const off = listen<{ course_id: number; kind: DocKind; doc_id: string }>("open-doc", ({ payload }) =>
      openDocLater.current(payload.course_id, payload.kind, payload.doc_id),
    );
    return () => void off.then((f) => f());
  }, []);
  const smart = pinned.filter((p): p is PinnedItem & { type: "smart" } => p.type === "smart");
  const folder = view.kind === "smart" ? smart.find((f) => f.name === view.name) ?? null : null;
  const scopeCourses = useMemo(() => {
    if (browsing === null) return [];
    return courseList.filter((c) => under(c.dir, browsing) || under(browsing, c.dir)).map((c) => c.id);
  }, [browsing, courseList]);

  const searching = view.kind === "home" || (filesView && query.trim() !== "");
  const results = useSearch(
    view.kind === "smart" ? `${folder?.query}|${folder?.courses}|${folder?.kinds}|${folder?.content}` : query,
    () => {
      if (view.kind === "smart") {
        return folder
          ? api.search(folder.query, { courses: folder.courses, kinds: folder.kinds, namesOnly: !folder.content, limit: 500 })
          : Promise.resolve([]);
      }
      if (!query.trim()) return Promise.resolve([]);
      if (browsing !== null && browsing !== "" && scopeCourses.length === 0) return Promise.resolve([]);
      return api.search(query, { limit: 300, courses: browsing ? scopeCourses : [] });
    },
    [view, folder, scopeCourses.join(","), version],
  );

  // -- actions --------------------------------------------------------------------------
  const signedOut = account !== null && !account.signed_in;
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

  const say = (message: string) => setNotice(message);
  const fail = (what: string) => (e: unknown) => say(t("{what}：{why}", { what, why: friendly((e as Error).message) }));

  const isPinned = (path: string) => pinned.some((p) => p.type === "folder" && p.path === path);
  const isCoursePinned = (id: number) => pinned.some((p) => p.type === "course" && p.id === id);
  const coursePinItem = (c: Course): MenuItem =>
    isCoursePinned(c.id)
      ? { label: t("取消置顶"), onSelect: () => api.unpinCourse(c.id).then(setPinned, fail(t("取消置顶失败"))) }
      : { label: t("置顶"), onSelect: () => api.pinCourse(c.id).then(setPinned, fail(t("置顶失败"))) };
  const pinItem = (path: string): MenuItem =>
    isPinned(path)
      ? { label: t("取消置顶"), onSelect: () => api.unpinFolder(path).then(setPinned, fail(t("取消置顶失败"))) }
      : { label: t("置顶"), onSelect: () => api.pinFolder(path).then(setPinned, fail(t("置顶失败"))) };
  const moveItems = (item: PinnedItem): MenuItem[] => {
    const i = pinned.indexOf(item);
    return [
      { label: t("上移"), disabled: i <= 0, onSelect: () => api.movePinned(i, i - 1).then(setPinned, fail(t("移动失败"))) },
      { label: t("下移"), disabled: i >= pinned.length - 1, onSelect: () => api.movePinned(i, i + 1).then(setPinned, fail(t("移动失败"))) },
    ];
  };

  /** Rename a folder, then follow it: any open view inside it moves to the new path. */
  const renameFolder = async (path: string, name: string) => {
    setRenaming(null);
    setRenameDialog(null);
    try {
      const { path: renamed } = await api.rename(path, name);
      const move = (p: string) => (under(p, path) ? renamed + p.slice(path.length) : p);
      setHist((h) => ({
        ...h,
        stack: h.stack.map((v) => (v.kind === "browse" || v.kind === "course" ? { ...v, path: move(v.path), select: v.select && move(v.select) } : v)),
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
        { label: t("打开"), hint: shortcut.open, onSelect: () => goPath(e.path) },
        { label: t("在 {app} 中显示", { app: fileManager }), onSelect: () => reveal(e.path) },
        "separator",
        // A course's own folder (seen in 全部文件) pins the course.
        ...(() => {
          const c = courseList.find((x) => x.id === e.course_id && x.dir === e.path);
          return [c ? coursePinItem(c) : pinItem(e.path)];
        })(),
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
      ...(h.path ? ["separator" as const, del] : []),
    ];
  };

  const unhide = (c: Course) =>
    api.hideCourse(c.id, false, c.excluded ? true : undefined).then(() => {
      say(c.excluded ? t("“{name}”回来了，下次同步时会更新", { name: c.label }) : t("“{name}”回来了", { name: c.label }));
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
    { label: t("查看文件"), onSelect: () => openCourse(c, "files") },
    { label: t("在 Canvas 中打开"), onSelect: () => void api.openUrl(`/courses/${c.id}`) },
    { label: t("在 {app} 中显示课程文件", { app: fileManager }), onSelect: () => reveal(c.dir) },
    "separator",
    { label: t("从 Canvas 同步此课程"), disabled: syncBusy, onSelect: () => startSync({ paths: [c.dir] }, c.label) },
    { label: t("恢复此课程的原版…"), disabled: !changes[c.id], onSelect: () => setRestoring({ scope: { paths: [c.dir] }, label: c.label }) },
    "separator",
    coursePinItem(c),
    {
      label: t("重命名课程…"), disabled: syncBusy,
      onSelect: () => setRenameDialog({ path: c.dir, title: t("重命名课程"), current: c.label, hint: t("只改在这里显示的名字，同步不受影响。") }),
    },
    ...(c.renamed ? [{ label: t("恢复原名（{name}）", { name: c.default_name }), disabled: syncBusy, onSelect: () => void renameFolder(c.dir, c.default_name) }] : []),
    { label: t("更换图标…"), onSelect: () => setChoosingIcon(c) },
    "separator",
    { label: t("新建智能文件夹（限此课程）…"), onSelect: () => setEditing({ folder: { name: "", query: "", courses: [c.id], kinds: [], content: false } }) },
    "separator",
    { label: t("隐藏此课程…"), onSelect: () => setHiding(c) },
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
    ];
  };

  const pinnedFolderMenu = (item: PinnedItem & { type: "folder" }): MenuItem[] => [
    { label: t("打开"), disabled: !item.exists, onSelect: () => goPath(item.path) },
    { label: t("在 {app} 中显示", { app: fileManager }), disabled: !item.exists, onSelect: () => reveal(item.path) },
    {
      label: t("重命名…"), disabled: !item.exists || syncBusy,
      onSelect: () => setRenameDialog({ path: item.path, title: t("重命名文件夹"), current: item.path.split("/").pop() ?? "" }),
    },
    "separator",
    ...moveItems(item),
    "separator",
    { label: t("取消置顶"), onSelect: () => api.unpinFolder(item.path).then(setPinned, fail(t("取消置顶失败"))) },
  ];

  const pinnedCourseMenu = (item: PinnedItem & { type: "course" }): MenuItem[] => {
    const c = courseList.find((x) => x.id === item.id);
    const unpinIt: MenuItem = { label: t("取消置顶"), onSelect: () => api.unpinCourse(item.id).then(setPinned, fail(t("取消置顶失败"))) };
    return c ? [...courseMenu(c), "separator", ...moveItems(item)] : [...moveItems(item), "separator", unpinIt];
  };

  const smartMenu = (f: PinnedItem & { type: "smart" }): MenuItem[] => [
    { label: t("编辑…"), onSelect: () => setEditing({ folder: f }) },
    "separator",
    ...moveItems(f),
    "separator",
    {
      label: t("删除智能文件夹"), danger: true,
      onSelect: async () => {
        setPinned(await api.deleteSmartFolder(f.name));
        if (view.kind === "smart" && view.name === f.name) go({ kind: "home" });
      },
    },
  ];

  const addMenu = (): MenuItem[] => {
    const here: MenuItem[] = [];
    if (course && browsing === course.dir && !isCoursePinned(course.id)) {
      here.push({ label: t("置顶此课程（{label}）", { label: course.label }), onSelect: () => api.pinCourse(course.id).then(setPinned, fail(t("置顶失败"))) });
    } else if (browsing && !isPinned(browsing)) {
      here.push({ label: t("置顶当前文件夹（{name}）", { name: browsing.split("/").pop()! }), onSelect: () => api.pinFolder(browsing).then(setPinned, fail(t("置顶失败"))) });
    }
    return [{ label: t("新建智能文件夹…"), onSelect: () => setEditing({ folder: null }) }, ...here];
  };

  // -- arranging the sidebar: drag pinned items, courses within a term, terms; fold sections -----
  const groups = useMemo(() => arrange(courseList.filter((c) => !c.hidden), order), [courseList, order]);
  const hiddenCourses = courseList.filter((c) => c.hidden);
  const pinDrag = useReorder(pinned.length, (from, to) => {
    setPinned(moved(pinned, from, to));
    api.movePinned(from, to).then(setPinned, fail(t("移动失败")));
  });
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
  const pinnedHere = pinned.some((p) => p.type === "folder" && p.path === browsing); // highlight that, not also its course
  const smartActive = (name: string) => view.kind === "smart" && view.name === name;
  const renderPinned = (item: PinnedItem) => {
    if (item.type === "course") {
      const c = courseList.find((x) => x.id === item.id);
      return (
        <NavItem
          icon={c ? <CourseIcon course={c} /> : <GraduationCap className="size-4" />}
          title={c?.label ?? t("课程 #{id}", { id: item.id })}
          subtitle={c ? (c.term_label ?? undefined) : t("找不到这门课了")}
          count={c?.new}
          muted={!c}
          active={course?.id === item.id && !pinnedHere}
          onClick={() => c && openCourse(c)}
          onMenu={(x, y) => openMenu(pinnedCourseMenu(item), x, y)}
        />
      );
    }
    if (item.type === "folder") {
      return (
        <NavItem
          icon={<Folder className="size-4" />}
          title={item.path.split("/").pop() ?? item.path}
          subtitle={item.exists ? pinnedWhere(item, courseList) : t("找不到这个文件夹了")}
          muted={!item.exists}
          active={browsing === item.path}
          onClick={() => item.exists && goPath(item.path)}
          onMenu={(x, y) => openMenu(pinnedFolderMenu(item), x, y)}
        />
      );
    }
    return (
      <NavItem
        icon={<Sparkles className="size-4" />}
        title={item.name}
        active={smartActive(item.name)}
        onClick={() => go({ kind: "smart", name: item.name })}
        onMenu={(x, y) => openMenu(smartMenu(item), x, y)}
      />
    );
  };

  return (
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

          <SectionHeader
            title={t("置顶@@heading")}
            collapsed={isCollapsed("pinned")}
            onToggle={() => toggle("pinned")}
            action={{ label: t("添加到置顶"), icon: <Plus className="size-3.5" />, onClick: (x, y) => openMenu(addMenu(), x, y) }}
          />
          {pinned.length === 0 && !isCollapsed("pinned") && (
            <p className="px-2 py-1 text-xs leading-relaxed text-muted">
              {t("右键课程或文件夹选择“置顶”，或点 + 新建智能文件夹（保存的搜索）。")}
            </p>
          )}
          {!isCollapsed("pinned") && pinned.map((item, i) => (
            <div key={pinnedKey(item)} {...pinDrag.item(i)} className={`relative ${pinDrag.dragging === i ? "opacity-40" : ""}`}>
              <DropMark at={pinDrag.mark(i)} />
              {renderPinned(item)}
            </div>
          ))}

          {courseList.length === 0 && !signedOut && (
            <p className="px-2 py-3 text-xs leading-relaxed text-muted">{sync?.running ? t("正在第一次同步，课程马上就会出现在这里。") : t("还没有课程。点上面的“同步”从 Canvas 拉取。")}</p>
          )}
          {groups.map((g, i) => (
            <TermSection
              key={g.key}
              group={g}
              sectionRef={termDrag.ref(i)}
              grab={termDrag.handle(i)}
              mark={termDrag.mark(i)}
              dragging={termDrag.dragging === i}
              collapsed={isCollapsed(`term:${g.key}`)}
              onToggle={() => toggle(`term:${g.key}`)}
              onMenu={(x, y) => openMenu(termMenu(g.label, g.courses), x, y)}
              onReorder={(ids) => reorderTerm(g.key, ids)}
              renderCourse={(c) => (
                <NavItem
                  icon={<CourseIcon course={c} />}
                  title={c.label}
                  subtitle={c.renamed ? c.display_code : c.name !== c.display_code ? c.name : undefined}
                  active={course?.id === c.id && !pinnedHere && !isCoursePinned(c.id)}
                  badge={changes[c.id] ? t("{n} 个文件有本地改动", { n: changes[c.id] }) : undefined}
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
              {hiddenOpen && hiddenCourses.map((c) => (
                <NavItem
                  key={c.id}
                  icon={<CourseIcon course={c} />}
                  title={c.label}
                  subtitle={c.excluded ? t("不再同步") : (c.term_label ?? undefined)}
                  muted
                  active={course?.id === c.id}
                  onClick={() => openCourse(c)}
                  onMenu={(x, y) => openMenu(hiddenCourseMenu(c), x, y)}
                />
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
            {view.kind === "browse" && <Breadcrumb path={view.path} onGo={goPath} />}
            {view.kind === "course" && course && (
              <Breadcrumb
                path={view.tab === "files" ? view.path : course.dir}
                root={{ path: course.dir, label: course.label, icon: <CourseIcon course={course} /> }}
                onGo={(p) => (p === course.dir && view.tab !== "files" ? openCourse(course) : goPath(p))}
              />
            )}
            {view.kind === "smart" && folder && <SmartTitle folder={folder} courses={courseList} />}
            {view.kind === "home" && <span className="text-sm font-medium">{t("搜索所有课程")}</span>}
            {view.kind === "settings" && <span className="text-sm font-medium">{t("设置")}</span>}
          </div>
          {view.kind !== "home" && view.kind !== "settings" && (
            <>
              {filesView && (
                <SearchInput inputRef={searchBox} value={query} onChange={setQuery} placeholder={course ? t("在 {label} 中搜索", { label: course.label }) : t("搜索")} compact />
              )}
              {(filesTab || view.kind === "smart" || searching) && (
                <div className="flex shrink-0 rounded-md border border-line p-0.5">
                  <ToolButton title={t("列表")} pressed={mode === "list"} onClick={() => setMode("list")}><List className="size-4" /></ToolButton>
                  <ToolButton title={t("图标")} pressed={mode === "grid"} onClick={() => setMode("grid")}><LayoutGrid className="size-4" /></ToolButton>
                </div>
              )}
              {filesTab && !searching && (
                <>
                  <ToolButton
                    title={`${showDeleted ? t("隐藏你删除的文件") : t("显示你删除的文件")}${shortcut.toggleDeleted ? ` (${shortcut.toggleDeleted})` : ""}`}
                    pressed={showDeleted}
                    onClick={() => setShowDeleted(!showDeleted)}
                  >
                    {showDeleted ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                  </ToolButton>
                  <ToolButton
                    title={t("此文件夹的操作")}
                    onClick={(ev) => {
                      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                      const here = browsing ?? "";
                      const label = course && here === course.dir ? course.label : here ? here.split("/").pop()! : t("全部文件");
                      openMenu([
                        { label: t("从 Canvas 同步此文件夹"), disabled: syncBusy, onSelect: () => (here ? startSync({ paths: [here] }, label) : startSync({}, t("全部课程"))) },
                        { label: t("恢复此文件夹的原版…"), onSelect: () => setRestoring({ scope: { paths: [here] }, label }) },
                        { label: t("在 {app} 中显示", { app: fileManager }), onSelect: () => void api.openPath(here, { reveal: here !== "" }) },
                        ...(course ? ["separator" as const, { label: t("在 Canvas 中打开这门课"), onSelect: () => void api.openUrl(`/courses/${course.id}`) }] : []),
                      ], r.right - 200, r.bottom + 4);
                    }}
                  >
                    <MoreHorizontal className="size-4" />
                  </ToolButton>
                </>
              )}
              {view.kind === "smart" && folder && (
                <Button onClick={() => setEditing({ folder })} className="shrink-0 text-xs">{t("编辑")}</Button>
              )}
            </>
          )}
        </header>

        {view.kind === "home" && (
          <div className="border-b border-line px-6 py-3">
            <SearchInput inputRef={searchBox} value={query} onChange={setQuery} placeholder={t("搜索所有课程… 例如 221 mt")} autoFocus />
          </div>
        )}

        {view.kind === "course" && course && (
          <CourseTabs
            tab={view.tab}
            overview={overview}
            order={tabs.order}
            hidden={tabs.hidden}
            onArrange={arrangeCourseTabs}
            onMenu={openMenu}
            onTab={(t) => go({ ...view, tab: t, item: undefined, select: undefined })}
            onMarkAllSeen={() => void api.markSeen(course.id).then(refresh, fail(t("标记失败")))}
          />
        )}

        {view.kind === "settings" ? (
          <Settings sync={sync} onSync={() => void startSync({}, t("全部课程"))} onAccount={(a) => (setAccount(a), refresh())} />
        ) : view.kind === "course" && course && !searching && view.tab === "overview" ? (
          <CourseOverview
            course={course}
            overview={overview}
            onOpen={(kind, id) => openDoc(course.id, kind, id)}
            onTab={(t) => go({ ...view, tab: t, item: undefined })}
            onSeen={seenChanged}
            cards={cards.order}
            hiddenCards={cards.hidden}
            onArrange={(order, hidden) => {
              setCards({ order, hidden });
              void api.setPrefs({ overview_order: order, overview_hidden: hidden }).catch(fail(t("操作失败")));
            }}
            onMenu={openMenu}
            onMarkSeen={(kinds) => void api.markSeen(course.id, kinds).then(refresh, fail(t("标记失败")))}
          />
        ) : view.kind === "course" && course && !searching && view.tab === "modules" ? (
          <CourseModules
            key={course.id}
            course={course}
            version={version}
            onOpenDoc={(kind, id) => openDoc(course.id, kind, id)}
            onShowFolder={(p) => goPath(p)}
          />
        ) : view.kind === "course" && course && !searching && view.tab === "grades" ? (
          <CourseGrades key={course.id} course={course} version={version} onOpenDoc={(kind, id) => openDoc(course.id, kind, id)} />
        ) : view.kind === "course" && course && !searching && view.tab !== "files" ? (
          <CourseReader
            course={course}
            tab={view.tab}
            selected={view.item ?? null}
            version={version}
            onSelect={(id) => replaceView({ ...view, item: id })}
            onNavigate={(to) => go({ ...view, tab: to.tab, item: to.id })}
            onSeen={seenChanged}
          />
        ) : (view.kind === "browse" || view.kind === "course") && !searching ? (
          <FileBrowser
            path={view.path}
            root={course?.dir ?? ""}
            select={view.select}
            version={version}
            mode={mode}
            showDeleted={showDeleted}
            onNavigate={goPath}
            onOpen={(e) => (e.deleted ? setRestoring({ scope: restoreScope(e), label: e.name }) : void api.openPath(e.path))}
            onPreview={(e) => void api.openPath(e.path, { preview: true })}
            onMenu={(es, x, y) => openMenu(entriesMenu(es), x, y)}
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
            mode={view.kind === "home" ? "list" : mode}
            query={query}
            results={results}
            showCourse={!course}
            onOpen={openHere}
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
      <Notice message={notice} onDone={() => setNotice(null)} />
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
          course={hiding}
          onClose={() => setHiding(null)}
          onDone={() => {
            say(t("已隐藏“{name}”", { name: hiding.label }));
            if (view.kind === "course" && view.id === hiding.id) go({ kind: "home" });
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
          initial={editing.folder?.name ? editing.folder : null}
          preset={editing.folder}
          courses={courseList}
          onClose={() => setEditing(null)}
          onSaved={(items, name) => {
            setPinned(items);
            setEditing(null);
            go({ kind: "smart", name });
          }}
        />
      )}
    </div>
  );
}

// -- pieces -----------------------------------------------------------------------------

const pinnedKey = (item: PinnedItem) =>
  item.type === "course" ? `course:${item.id}` : item.type === "folder" ? `folder:${item.path}` : `smart:${item.name}`;

/** A term in the sidebar: its header folds it and drags it among the terms; its courses drag
 * among themselves. */
function TermSection({ group, sectionRef, grab, mark, dragging, collapsed, onToggle, onMenu, onReorder, renderCourse }: {
  group: TermGroup;
  sectionRef: (el: HTMLElement | null) => void;
  grab: { onPointerDown: (e: React.PointerEvent) => void };
  mark: Mark;
  dragging: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onMenu: (x: number, y: number) => void;
  onReorder: (ids: number[]) => void;
  renderCourse: (c: Course) => React.ReactNode;
}) {
  const drag = useReorder(group.courses.length, (from, to) => onReorder(moved(group.courses, from, to).map((c) => c.id)));
  const fresh = group.courses.reduce((n, c) => n + c.new, 0);
  return (
    <section ref={sectionRef} className={`relative ${dragging ? "opacity-40" : ""}`}>
      <DropMark at={mark} />
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
        <div key={c.id} {...drag.item(i)} className={`relative ${drag.dragging === i ? "opacity-40" : ""}`}>
          <DropMark at={drag.mark(i)} />
          {renderCourse(c)}
        </div>
      ))}
    </section>
  );
}

/** Where a pinned folder is, for its subtitle: its course (or term), else its parent folder. */
function pinnedWhere(item: { path: string; course_id: number | null }, courses: Course[]): string {
  const c = courses.find((x) => x.id === item.course_id);
  if (c && item.path === c.dir) return c.term_label ?? "";
  if (c) return c.label;
  return parentOf(item.path) || t("全部文件");
}

/** A short message at the bottom of the window that goes away by itself. */
function Notice({ message, onDone }: { message: string | null; onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => done.current(), 5000); // per message, not per re-render
    return () => clearTimeout(t);
  }, [message]);
  if (!message) return null;
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-panel px-4 py-2 text-sm shadow-xl">
      {message}
    </div>
  );
}

function Results({ view, mode, query, results, showCourse, onOpen, onMenu, onDelete }: {
  view: View;
  mode: ViewMode;
  query: string;
  results: { hits: Hit[]; error: string | null; loading: boolean };
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
  const asked = view.kind === "smart" || query.trim() !== "";

  const header = (
    <>
      {hits.length > 0 && Object.keys(counts).length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-2 text-xs">
          <Chip active={!kind} onClick={() => setKind(null)}>{t("全部")} {hits.length}</Chip>
          {(Object.keys(KIND) as Kind[]).filter((k) => counts[k]).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{KIND[k].label} {counts[k]}</Chip>
          ))}
        </div>
      )}
      {error && <p className="px-2 py-6 text-sm text-danger whitespace-pre-wrap">{error}</p>}
      {!error && !asked && view.kind === "home" && <Welcome />}
      {!error && asked && !loading && shown.length === 0 && <p className="px-2 py-10 text-center text-sm text-muted">{t("没有结果")}</p>}
    </>
  );
  return <HitBrowser hits={shown} mode={mode} showCourse={showCourse} header={header} onOpen={onOpen} onMenu={onMenu} onDelete={onDelete} />;
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

function SmartTitle({ folder, courses }: { folder: SmartFolder; courses: Course[] }) {
  const names = folder.courses.map((id) => courses.find((c) => c.id === id)?.label ?? `#${id}`);
  const bits = [
    folder.query && `“${folder.query}”`,
    names.length ? names.join(t("、")) : t("所有课程"),
    folder.kinds.length ? folder.kinds.map((k) => KIND[k].label).join(t("、")) : "",
    folder.content ? t("含正文") : t("只看名称"),
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium"><Sparkles className="size-4 text-accent" />{folder.name}</span>
      <span className="truncate text-xs text-muted">{bits.join(" · ")}</span>
    </div>
  );
}

function NavItem({ icon, title, subtitle, active, badge, count, muted, onClick, onMenu }: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  active: boolean;
  muted?: boolean;
  badge?: string;
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
        {badge && <span title={badge} aria-label={badge} className="size-1.5 shrink-0 rounded-full bg-warn group-hover:hidden" />}
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
        {tx("输入课程名加关键词，例如 {a}、{b}、{c}。缩写会自动展开：mt = midterm，hw = homework，sol = solution。", {
          a: <code className="text-fg-soft">221 mt</code>,
          b: <code className="text-fg-soft">cs70 hw3 sol</code>,
          c: <code className="text-fg-soft">{t("期中")}</code>,
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
