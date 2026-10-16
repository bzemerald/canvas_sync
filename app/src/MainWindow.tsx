import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronLeft, ChevronRight, Eye, EyeOff, FolderTree, LayoutGrid, List, MoreHorizontal, Plus, RefreshCw, Search, Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./components/Dialog";
import { FileBrowser, parentOf, type ViewMode } from "./components/FileBrowser";
import { ContextMenu, type MenuItem, type MenuState } from "./components/Menu";
import { HitGrid, HitList, KIND, fileManager, isMac } from "./components/Result";
import { RestoreDialog } from "./components/RestoreDialog";
import { SmartFolderDialog } from "./components/SmartFolderDialog";
import * as api from "./lib/api";
import type { Course, Entry, Hit, Kind, Scope, SmartFolder, SyncState } from "./lib/api";
import { usePref } from "./lib/prefs";
import { useSearch } from "./lib/useSearch";

type View =
  | { kind: "home" }
  | { kind: "browse"; path: string; select?: string }
  | { kind: "smart"; name: string };

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
    const term = c.term ?? "无学期";
    groups.set(term, [...(groups.get(term) ?? []), c]);
  }
  return [...groups.entries()].sort(([a], [b]) => termRank(b) - termRank(a));
}

const under = (path: string, dir: string) => dir === "" || path === dir || path.startsWith(dir + "/");
const RESTORABLE = new Set(["modified", "missing", "ignored"]);
const primaryKey = (e: KeyboardEvent | React.KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

export function MainWindow() {
  const [courseList, setCourseList] = useState<Course[]>([]);
  const [smart, setSmart] = useState<SmartFolder[]>([]);
  const [hist, setHist] = useState<{ stack: View[]; i: number }>({ stack: [{ kind: "home" }], i: 0 });
  const [query, setQuery] = useState("");
  const [mode, setMode] = usePref<ViewMode>("viewMode", "list");
  const [showDeleted, setShowDeleted] = usePref("showDeleted", false);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [syncLabel, setSyncLabel] = useState("");
  const [changes, setChanges] = useState<Record<number, number>>({});
  const [version, setVersion] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [restoring, setRestoring] = useState<{ scope: Scope; label: string } | null>(null);
  const [editing, setEditing] = useState<{ folder: SmartFolder | null } | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  const view = hist.stack[hist.i];
  const go = useCallback((v: View) => {
    setQuery("");
    setHist((h) => ({ stack: [...h.stack.slice(0, h.i + 1), v], i: h.i + 1 }));
  }, []);
  const step = (d: number) => setHist((h) => ({ ...h, i: Math.max(0, Math.min(h.stack.length - 1, h.i + d)) }));
  const refresh = () => setVersion((n) => n + 1);

  // -- data ------------------------------------------------------------------------
  useEffect(() => {
    api.courses().then(setCourseList, (e) => setStartupError(String(e.message ?? e)));
    api.smartFolders().then(setSmart, () => {});
  }, [version]);
  useEffect(() => void api.syncState().then(setSync).catch(() => {}), []);
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

  // While a sync runs, poll its progress; when it ends, reload what it changed.
  useEffect(() => {
    if (!sync?.running) return;
    const timer = setInterval(async () => {
      const next = await api.syncState();
      setSync(next);
      if (!next.running) refresh();
    }, 500);
    return () => clearInterval(timer);
  }, [sync?.running]);

  // ⌘F search, ⌘[ / ⌘] back and forward.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!primaryKey(e)) return;
      if (e.key.toLowerCase() === "f") searchBox.current?.focus();
      else if (e.key === "[") step(-1);
      else if (e.key === "]") step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // -- where we are ---------------------------------------------------------------------
  const browsing = view.kind === "browse" ? view.path : null;
  const course = browsing !== null ? courseList.find((c) => under(browsing, c.dir)) ?? null : null;
  const folder = view.kind === "smart" ? smart.find((f) => f.name === view.name) ?? null : null;
  const scopeCourses = useMemo(() => {
    if (browsing === null) return [];
    return courseList.filter((c) => under(c.dir, browsing) || under(browsing, c.dir)).map((c) => c.id);
  }, [browsing, courseList]);

  const searching = view.kind === "home" || (view.kind === "browse" && query.trim() !== "");
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
  const startSync = async (scope: Scope, label: string) => {
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

  const entryMenu = (e: Entry): MenuItem[] => {
    if (e.type === "dir") {
      return [
        { label: "打开", onSelect: () => go({ kind: "browse", path: e.path }) },
        { label: `在 ${fileManager} 中显示`, onSelect: () => reveal(e.path) },
        "separator",
        { label: "从 Canvas 同步此文件夹", disabled: syncBusy, onSelect: () => startSync({ paths: [e.path] }, e.name) },
        { label: "恢复此文件夹的原版…", disabled: !e.changes, onSelect: () => setRestoring({ scope: { paths: [e.path] }, label: e.name }) },
      ];
    }
    if (e.deleted) {
      return [
        { label: "恢复…", onSelect: () => setRestoring({ scope: { file_ids: [e.file_id!] }, label: e.name }) },
        ...(e.url ? [{ label: "在 Canvas 中打开", onSelect: () => void api.openUrl(e.url!) }] : []),
      ];
    }
    const items: MenuItem[] = [
      { label: "打开", onSelect: () => void api.openPath(e.path) },
      ...(isMac ? [{ label: "快速预览", hint: "空格", onSelect: () => void api.openPath(e.path, { preview: true }) }] : []),
      { label: `在 ${fileManager} 中显示`, onSelect: () => reveal(e.path) },
    ];
    if (e.url) items.push({ label: "在 Canvas 中打开", onSelect: () => void api.openUrl(e.url!) });
    if (e.link) items.push({ label: "显示原始文件", onSelect: () => go({ kind: "browse", path: parentOf(e.link!), select: e.link! }) });
    if (e.file_id !== null) {
      items.push(
        "separator",
        { label: "从 Canvas 同步", disabled: syncBusy, onSelect: () => startSync({ file_ids: [e.file_id!] }, e.name) },
        { label: "恢复 Canvas 原版…", disabled: !e.states.includes("modified"), onSelect: () => setRestoring({ scope: { file_ids: [e.file_id!] }, label: e.name }) },
      );
    }
    return items;
  };

  const hitMenu = (h: Hit): MenuItem[] => [
    { label: "打开", onSelect: () => void api.openHit(h) },
    ...(h.path
      ? [
          { label: "在文件夹中显示", onSelect: () => go({ kind: "browse", path: parentOf(h.path!), select: h.path! }) },
          { label: `在 ${fileManager} 中显示`, onSelect: () => reveal(h.path!) },
        ]
      : []),
    ...(h.url ? [{ label: "在 Canvas 中打开", onSelect: () => void api.openUrl(h.url!) }] : []),
  ];

  const courseMenu = (c: Course): MenuItem[] => [
    { label: "打开", onSelect: () => go({ kind: "browse", path: c.dir }) },
    { label: `在 ${fileManager} 中显示`, onSelect: () => reveal(c.dir) },
    { label: "在 Canvas 中打开", onSelect: () => void api.openUrl(`/courses/${c.id}`) },
    "separator",
    { label: "从 Canvas 同步此课程", disabled: syncBusy, onSelect: () => startSync({ paths: [c.dir] }, c.display_code) },
    { label: "恢复此课程的原版…", disabled: !changes[c.id], onSelect: () => setRestoring({ scope: { paths: [c.dir] }, label: c.display_code }) },
    "separator",
    { label: "新建智能文件夹（限此课程）…", onSelect: () => setEditing({ folder: { name: "", query: "", courses: [c.id], kinds: [], content: false } }) },
  ];

  const termMenu = (term: string, list: Course[]): MenuItem[] => [
    { label: `从 Canvas 同步 ${term}`, disabled: syncBusy, onSelect: () => startSync({ paths: list.map((c) => c.dir) }, term) },
    { label: `恢复 ${term} 的原版…`, disabled: !list.some((c) => changes[c.id]), onSelect: () => setRestoring({ scope: { paths: list.map((c) => c.dir) }, label: term }) },
  ];

  const smartMenu = (f: SmartFolder): MenuItem[] => [
    { label: "编辑…", onSelect: () => setEditing({ folder: f }) },
    {
      label: "删除", danger: true,
      onSelect: async () => {
        setSmart(await api.deleteSmartFolder(f.name));
        if (view.kind === "smart" && view.name === f.name) go({ kind: "home" });
      },
    },
  ];

  if (startupError) return <StartupError message={startupError} />;

  // -- layout ---------------------------------------------------------------------------
  const isActive = (v: View) =>
    v.kind === view.kind && (v.kind !== "browse" || (view.kind === "browse" && v.path === view.path)) && (v.kind !== "smart" || (view.kind === "smart" && v.name === view.name));

  return (
    <div className="flex h-screen bg-bg text-fg">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h1 className="text-sm font-semibold">Canvas Sync</h1>
          <button
            onClick={() => startSync({}, "全部课程")}
            disabled={syncBusy}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-soft hover:bg-chip disabled:opacity-60"
            title="从 Canvas 拉取所有课程的新文件"
          >
            <RefreshCw className={`size-3.5 ${syncBusy ? "animate-spin" : ""}`} aria-hidden />
            同步
          </button>
        </div>
        <SyncStatus sync={sync} label={syncLabel} />
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <NavItem icon={<Search className="size-4" />} active={isActive({ kind: "home" })} onClick={() => go({ kind: "home" })} title="搜索" />
          <NavItem icon={<FolderTree className="size-4" />} active={isActive({ kind: "browse", path: "" })} onClick={() => go({ kind: "browse", path: "" })} title="全部文件" />

          <SectionHeader title="智能文件夹" action={{ label: "新建智能文件夹", icon: <Plus className="size-3.5" />, onClick: () => setEditing({ folder: null }) }} />
          {smart.length === 0 && (
            <button onClick={() => setEditing({ folder: null })} className="w-full px-2 py-1 text-left text-xs text-muted hover:text-fg-soft">
              把常用的搜索存成文件夹…
            </button>
          )}
          {smart.map((f) => (
            <NavItem
              key={f.name}
              icon={<Sparkles className="size-4" />}
              title={f.name}
              active={isActive({ kind: "smart", name: f.name })}
              onClick={() => go({ kind: "smart", name: f.name })}
              onMenu={(x, y) => openMenu(smartMenu(f), x, y)}
            />
          ))}

          {groupByTerm(courseList).map(([term, list]) => (
            <section key={term}>
              <SectionHeader title={term} action={{ label: `${term} 的操作`, icon: <MoreHorizontal className="size-3.5" />, onClick: (x, y) => openMenu(termMenu(term, list), x, y) }} onMenu={(x, y) => openMenu(termMenu(term, list), x, y)} />
              {list.map((c) => (
                <NavItem
                  key={c.id}
                  title={c.display_code}
                  subtitle={c.name !== c.display_code ? c.name : undefined}
                  active={course?.id === c.id}
                  badge={changes[c.id] ? `${changes[c.id]} 个文件有本地改动` : undefined}
                  onClick={() => go({ kind: "browse", path: c.dir })}
                  onMenu={(x, y) => openMenu(courseMenu(c), x, y)}
                />
              ))}
            </section>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <div className="flex shrink-0">
            <ToolButton title={`后退 (${isMac ? "⌘[" : "Ctrl+["})`} disabled={hist.i === 0} onClick={() => step(-1)}><ChevronLeft className="size-4" /></ToolButton>
            <ToolButton title={`前进 (${isMac ? "⌘]" : "Ctrl+]"})`} disabled={hist.i === hist.stack.length - 1} onClick={() => step(1)}><ChevronRight className="size-4" /></ToolButton>
          </div>
          <div className="min-w-0 flex-1">
            {view.kind === "browse" && <Breadcrumb path={view.path} onGo={(p) => go({ kind: "browse", path: p })} />}
            {view.kind === "smart" && folder && <SmartTitle folder={folder} courses={courseList} />}
            {view.kind === "home" && <span className="text-sm font-medium">搜索所有课程</span>}
          </div>
          {view.kind !== "home" && (
            <>
              {view.kind === "browse" && (
                <SearchInput inputRef={searchBox} value={query} onChange={setQuery} placeholder={course ? `在 ${course.display_code} 中搜索` : "搜索"} compact />
              )}
              <div className="flex shrink-0 rounded-md border border-line p-0.5">
                <ToolButton title="列表" pressed={mode === "list"} onClick={() => setMode("list")}><List className="size-4" /></ToolButton>
                <ToolButton title="图标" pressed={mode === "grid"} onClick={() => setMode("grid")}><LayoutGrid className="size-4" /></ToolButton>
              </div>
              {view.kind === "browse" && (
                <>
                  <ToolButton title={showDeleted ? "隐藏你删除的文件" : "显示你删除的文件"} pressed={showDeleted} onClick={() => setShowDeleted(!showDeleted)}>
                    {showDeleted ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                  </ToolButton>
                  <ToolButton
                    title="此文件夹的操作"
                    onClick={(ev) => {
                      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                      const here = view.path;
                      const label = here ? here.split("/").pop()! : "全部文件";
                      openMenu([
                        { label: "从 Canvas 同步此文件夹", disabled: syncBusy, onSelect: () => (here ? startSync({ paths: [here] }, label) : startSync({}, "全部课程")) },
                        { label: "恢复此文件夹的原版…", onSelect: () => setRestoring({ scope: { paths: [here] }, label }) },
                        { label: `在 ${fileManager} 中显示`, onSelect: () => void api.openPath(here, { reveal: here !== "" }) },
                        ...(course ? ["separator" as const, { label: "在 Canvas 中打开此课程", onSelect: () => void api.openUrl(`/courses/${course.id}`) }] : []),
                      ], r.right - 200, r.bottom + 4);
                    }}
                  >
                    <MoreHorizontal className="size-4" />
                  </ToolButton>
                </>
              )}
              {view.kind === "smart" && folder && (
                <Button onClick={() => setEditing({ folder })} className="shrink-0 text-xs">编辑</Button>
              )}
            </>
          )}
        </header>

        {view.kind === "home" && (
          <div className="border-b border-line px-6 py-3">
            <SearchInput inputRef={searchBox} value={query} onChange={setQuery} placeholder="搜索所有课程… 例如 221 mt" autoFocus />
          </div>
        )}

        {view.kind === "browse" && !searching ? (
          <FileBrowser
            path={view.path}
            select={view.select}
            version={version}
            mode={mode}
            showDeleted={showDeleted}
            onNavigate={(p) => go({ kind: "browse", path: p })}
            onOpen={(e) => (e.deleted ? setRestoring({ scope: { file_ids: [e.file_id!] }, label: e.name }) : void api.openPath(e.path))}
            onPreview={(e) => void api.openPath(e.path, { preview: true })}
            onMenu={(e, x, y) => openMenu(entryMenu(e), x, y)}
          />
        ) : (
          <Results
            view={view}
            mode={view.kind === "home" ? "list" : mode}
            query={query}
            results={results}
            showCourse={view.kind !== "browse" || !course}
            onMenu={(h, x, y) => openMenu(hitMenu(h), x, y)}
          />
        )}
      </main>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
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
          onSaved={(folders, name) => {
            setSmart(folders);
            setEditing(null);
            go({ kind: "smart", name });
          }}
        />
      )}
    </div>
  );
}

// -- pieces -----------------------------------------------------------------------------

function Results({ view, mode, query, results, showCourse, onMenu }: {
  view: View;
  mode: ViewMode;
  query: string;
  results: { hits: Hit[]; error: string | null; loading: boolean };
  showCourse: boolean;
  onMenu: (h: Hit, x: number, y: number) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const { hits, error, loading } = results;
  useEffect(() => setKind(null), [view]);
  const shown = kind ? hits.filter((h) => h.kind === kind) : hits;
  const counts: Partial<Record<Kind, number>> = {};
  for (const h of hits) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  const asked = view.kind === "smart" || query.trim() !== "";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {hits.length > 0 && Object.keys(counts).length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-2 text-xs">
          <Chip active={!kind} onClick={() => setKind(null)}>全部 {hits.length}</Chip>
          {(Object.keys(KIND) as Kind[]).filter((k) => counts[k]).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{KIND[k].label} {counts[k]}</Chip>
          ))}
        </div>
      )}
      {error && <p className="px-2 py-6 text-sm text-danger whitespace-pre-wrap">{error}</p>}
      {!error && !asked && view.kind === "home" && <Welcome />}
      {!error && asked && !loading && shown.length === 0 && <p className="px-2 py-10 text-center text-sm text-muted">没有结果</p>}
      {mode === "grid" ? <HitGrid hits={shown} onMenu={onMenu} /> : <HitList hits={shown} showCourse={showCourse} onMenu={onMenu} />}
    </div>
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
        placeholder={placeholder}
        className={`w-full bg-transparent outline-none placeholder:text-muted ${compact ? "h-7 text-sm" : "h-10"}`}
      />
    </div>
  );
}

function Breadcrumb({ path, onGo }: { path: string; onGo: (p: string) => void }) {
  const parts = path ? path.split("/") : [];
  return (
    <nav className="flex min-w-0 items-center gap-0.5 text-sm" aria-label="位置">
      <button onClick={() => onGo("")} className={`shrink-0 rounded px-1.5 py-0.5 hover:bg-chip ${parts.length ? "text-muted" : "font-medium"}`}>全部文件</button>
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight className="size-3.5 shrink-0 text-muted" />
          <button
            onClick={() => onGo(parts.slice(0, i + 1).join("/"))}
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
  const names = folder.courses.map((id) => courses.find((c) => c.id === id)?.display_code ?? `#${id}`);
  const bits = [
    folder.query && `“${folder.query}”`,
    names.length ? names.join("、") : "所有课程",
    folder.kinds.length ? folder.kinds.map((k) => KIND[k].label).join("、") : "",
    folder.content ? "含正文" : "只看名称",
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium"><Sparkles className="size-4 text-accent" />{folder.name}</span>
      <span className="truncate text-xs text-muted">{bits.join(" · ")}</span>
    </div>
  );
}

function NavItem({ icon, title, subtitle, active, badge, onClick, onMenu }: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  active: boolean;
  badge?: string;
  onClick: () => void;
  onMenu?: (x: number, y: number) => void;
}) {
  return (
    <div className="group relative">
      <button
        onClick={onClick}
        onContextMenu={onMenu && ((e) => (e.preventDefault(), onMenu(e.clientX, e.clientY)))}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${active ? "bg-selected text-fg" : "text-fg-soft hover:bg-chip"}`}
      >
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{title}</span>
          {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
        </span>
        {badge && <span title={badge} aria-label={badge} className="size-1.5 shrink-0 rounded-full bg-warn group-hover:hidden" />}
      </button>
      {onMenu && (
        <button
          aria-label={`${title} 的操作`}
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

function SectionHeader({ title, action, onMenu }: {
  title: string;
  action?: { label: string; icon: React.ReactNode; onClick: (x: number, y: number) => void };
  onMenu?: (x: number, y: number) => void;
}) {
  return (
    <div
      className="group mt-4 flex items-center justify-between px-2 pb-1"
      onContextMenu={onMenu && ((e) => (e.preventDefault(), onMenu(e.clientX, e.clientY)))}
    >
      <h2 className="text-[11px] font-medium tracking-wide text-muted uppercase">{title}</h2>
      {action && (
        <button
          title={action.label}
          aria-label={action.label}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            action.onClick(r.left, r.bottom + 2);
          }}
          className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-chip hover:text-fg focus:opacity-100"
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
  checking: "正在检查 Canvas…",
  downloading: "正在下载",
  indexing: "正在建立搜索索引",
  done: "已同步",
  failed: "同步失败",
};

const CHANGE: Record<string, string> = {
  download: "新文件", update: "更新", conflict: "冲突", move: "移动", ignore: "不再同步", remote_deleted: "已从 Canvas 删除", delete: "删除", pin: "记住新位置",
};

function SyncStatus({ sync, label }: { sync: SyncState | null; label: string }) {
  if (!sync || sync.phase === "idle") return null;
  const pct = sync.total ? Math.round((sync.done / sync.total) * 100) : null;
  const changes = Object.entries(sync.changes).map(([k, n]) => `${n} ${CHANGE[k] ?? k}`).join("，");
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
      {sync.phase === "done" && <p className="mt-0.5 text-muted">{changes || "没有新内容"}</p>}
      {sync.errors.slice(0, 3).map((e) => (
        <p key={e} className="mt-1 break-words text-danger">{e}</p>
      ))}
    </div>
  );
}

function Welcome() {
  return (
    <div className="mx-auto max-w-md px-2 py-16 text-sm text-muted">
      <p className="mb-4 text-base text-fg">在任何地方按 <kbd className="rounded border border-line bg-chip px-1.5">{isMac ? "⌘⇧Space" : "Ctrl+Shift+Space"}</kbd> 快速搜索。</p>
      <p>输入课程名加关键词，例如 <code className="text-fg-soft">221 mt</code>、<code className="text-fg-soft">cs70 hw3 sol</code>、<code className="text-fg-soft">期中</code>。缩写会自动展开：mt = midterm，hw = homework，sol = solution。</p>
      <p className="mt-3">左边选一门课可以浏览它的文件；右键课程、文件夹或文件可以单独同步或恢复。</p>
    </div>
  );
}

function StartupError({ message }: { message: string }) {
  const notSetUp = /not set up|canvas init/i.test(message);
  return (
    <div className="flex h-screen items-center justify-center bg-bg p-8 text-fg">
      <div className="max-w-lg">
        <h1 className="mb-2 text-lg font-semibold">{notSetUp ? "还没有连接 Canvas" : "后台服务没有启动"}</h1>
        {notSetUp ? (
          <p className="text-sm text-fg-soft">先在终端运行 <code>canvas init</code> 和 <code>canvas pull</code>，然后重新打开应用。</p>
        ) : (
          <pre className="overflow-auto rounded-md bg-chip p-3 text-xs whitespace-pre-wrap text-danger">{message}</pre>
        )}
      </div>
    </div>
  );
}
