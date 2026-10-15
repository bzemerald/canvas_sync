import { ExternalLink, FolderOpen, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KIND, ResultBody, fileManager, hitKey, isMac } from "./components/Result";
import * as api from "./lib/api";
import type { Course, Hit, Kind, SyncState } from "./lib/api";
import { useSearch } from "./lib/useSearch";

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

export function MainWindow() {
  const [courseList, setCourseList] = useState<Course[]>([]);
  const [course, setCourse] = useState<Course | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const loadCourses = useCallback(() => {
    api.courses().then(setCourseList, (e) => setStartupError(String(e.message ?? e)));
  }, []);
  useEffect(loadCourses, [loadCourses]);
  useEffect(() => void api.syncState().then(setSync).catch(() => {}), []);

  // ⌘F / Ctrl+F focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { hits, error, loading } = useSearch(
    query,
    (q) => (q.trim() || course ? api.search(q, { limit: 300, courses: course ? [course.id] : [] }) : Promise.resolve([])),
    [course?.id, refresh],
  );
  const shown = useMemo(() => (kind ? hits.filter((h) => h.kind === kind) : hits), [hits, kind]);
  const counts = useMemo(() => {
    const c: Partial<Record<Kind, number>> = {};
    for (const h of hits) c[h.kind] = (c[h.kind] ?? 0) + 1;
    return c;
  }, [hits]);

  // While a sync runs, poll its progress; when it ends, reload what it changed.
  useEffect(() => {
    if (!sync?.running) return;
    const timer = setInterval(async () => {
      const next = await api.syncState();
      setSync(next);
      if (!next.running) {
        loadCourses();
        setRefresh((n) => n + 1);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [sync?.running, loadCourses]);

  const startSync = async () => {
    try {
      setSync(await api.startSync());
    } catch (e) {
      setSync({ phase: "failed", running: false, errors: [String((e as Error).message)], warnings: [], total: 0, done: 0, current: "", changes: {}, finished_at: null });
    }
  };

  if (startupError) return <StartupError message={startupError} />;

  return (
    <div className="flex h-screen bg-bg text-fg">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h1 className="text-sm font-semibold">Canvas Sync</h1>
          <button
            onClick={startSync}
            disabled={sync?.running}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-soft hover:bg-chip disabled:opacity-60"
            title="从 Canvas 拉取新文件"
          >
            <RefreshCw className={`size-3.5 ${sync?.running ? "animate-spin" : ""}`} aria-hidden />
            同步
          </button>
        </div>
        <SyncStatus sync={sync} />
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <CourseButton active={!course} onClick={() => setCourse(null)} title="所有课程" />
          {groupByTerm(courseList).map(([term, list]) => (
            <section key={term} className="mt-4">
              <h2 className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{term}</h2>
              {list.map((c) => (
                <CourseButton
                  key={c.id}
                  active={course?.id === c.id}
                  onClick={() => setCourse(c)}
                  title={c.display_code}
                  subtitle={c.name !== c.display_code ? c.name : undefined}
                />
              ))}
            </section>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-line px-6 pt-5 pb-3">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 focus-within:border-accent">
            <Search className="size-4 text-muted" aria-hidden />
            <input
              ref={input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={course ? `在 ${course.display_code} 中搜索…` : "搜索所有课程… 例如 221 mt"}
              className="h-10 w-full bg-transparent outline-none placeholder:text-muted"
              autoFocus
            />
            {loading && <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />}
          </div>
          {hits.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              <Chip active={!kind} onClick={() => setKind(null)}>全部 {hits.length}</Chip>
              {(Object.keys(KIND) as Kind[]).filter((k) => counts[k]).map((k) => (
                <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>
                  {KIND[k].label} {counts[k]}
                </Chip>
              ))}
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && <p className="px-2 py-6 text-sm text-danger whitespace-pre-wrap">{error}</p>}
          {!error && !query.trim() && !course && <Welcome />}
          {!error && (query.trim() || course) && !loading && shown.length === 0 && (
            <p className="px-2 py-10 text-center text-sm text-muted">没有结果</p>
          )}
          <ul className="space-y-0.5">
            {shown.map((h) => (
              <ResultRow key={hitKey(h)} hit={h} showCourse={!course} />
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}

function ResultRow({ hit, showCourse }: { hit: Hit; showCourse: boolean }) {
  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-selected">
      <button className="min-w-0 flex-1 text-left" onClick={() => void api.openHit(hit)} title={hit.path ? "打开文件" : "在 Canvas 中打开"}>
        <ResultBody hit={hit} showCourse={showCourse} />
      </button>
      <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        {hit.path && (
          <IconButton title={`在 ${fileManager} 中显示`} onClick={() => void api.openHit(hit, true)}>
            <FolderOpen className="size-4" />
          </IconButton>
        )}
        {hit.url && (
          <IconButton title="在 Canvas 中打开" onClick={() => void api.openCanvas(hit)}>
            <ExternalLink className="size-4" />
          </IconButton>
        )}
      </div>
    </li>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-chip hover:text-fg">
      {children}
    </button>
  );
}

function CourseButton({ active, onClick, title, subtitle }: { active: boolean; onClick: () => void; title: string; subtitle?: string }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${active ? "bg-selected text-fg" : "text-fg-soft hover:bg-chip"}`}
    >
      <span className="block truncate">{title}</span>
      {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
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

function SyncStatus({ sync }: { sync: SyncState | null }) {
  if (!sync || sync.phase === "idle") return null;
  const pct = sync.total ? Math.round((sync.done / sync.total) * 100) : null;
  const changes = Object.entries(sync.changes)
    .map(([k, n]) => `${n} ${({ download: "新文件", update: "更新", conflict: "冲突", move: "移动", ignore: "忽略", remote_deleted: "已从 Canvas 删除", delete: "删除", pin: "固定" } as Record<string, string>)[k] ?? k}`)
    .join("，");
  return (
    <div className="mx-4 mb-2 rounded-md bg-chip px-2.5 py-2 text-xs text-fg-soft">
      <div className="flex justify-between">
        <span className={sync.phase === "failed" ? "text-danger" : ""}>{PHASE[sync.phase]}</span>
        {sync.running && pct !== null && <span>{sync.done}/{sync.total}</span>}
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
      <p className="mt-3">也可以在左边选一门课，浏览它的全部内容。</p>
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
