// Adding a card to a course's overview: what kind, then which folder, file, page, module, or
// what to search for. (Anything can also be dragged onto the overview.)
import {
  AppWindow, Award, BookOpen, ChevronLeft, ChevronRight, ClipboardList, FileText, Folder, FolderOpen, ListChecks, Megaphone,
  NotebookPen, ScrollText, Search as SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type { Course, Entry, ItemSummary, Module } from "../lib/api";
import { t } from "../lib/i18n";
import type { Shown, ViewName } from "../lib/things";
import { Button, Dialog } from "./Dialog";
import { FileIcon } from "./FileIcon";
import { Loading } from "./Status";

type Kind = "note" | "folder" | "file" | "page" | "module" | "search";
type Look = Kind | "assignments" | "announcements" | "modules" | "files" | "grades" | "tools" | "syllabus";

const icon = (Icon: typeof Folder) => <Icon className="size-4" />;
const KINDS: { kind: Kind; icon: React.ReactNode; label: string; hint: string }[] = [
  { kind: "note", icon: icon(NotebookPen), label: t("备忘录"), hint: t("随手记：考试范围、办公时间、要问老师的问题") },
  { kind: "folder", icon: icon(Folder), label: t("文件夹"), hint: t("某个文件夹里的文件，比如讲义或作业") },
  { kind: "file", icon: icon(FileText), label: t("文件@@card"), hint: t("一个常看的文件，比如课程表、公式表") },
  { kind: "page", icon: icon(BookOpen), label: t("页面@@card"), hint: t("Canvas 上的某个页面，比如老师更新进度的那页") },
  { kind: "module", icon: icon(ListChecks), label: t("模块@@card"), hint: t("固定显示某个模块，比如考试复习") },
  { kind: "search", icon: icon(SearchIcon), label: t("搜索"), hint: t("这门课里名字符合条件的东西，比如“mt”") },
];
/** The course's own cards, when hidden: what each shows. */
const OWN: Partial<Record<ViewName, { icon: React.ReactNode; hint: string }>> = {
  assignments: { icon: icon(ClipboardList), hint: t("接下来三周要交的作业") },
  announcements: { icon: icon(Megaphone), hint: t("最近的几条公告") },
  modules: { icon: icon(ListChecks), hint: t("现在在学的模块和里面的东西") },
  files: { icon: icon(FolderOpen), hint: t("最近从 Canvas 同步下来的文件") },
  grades: { icon: icon(Award), hint: t("当前总评和最近的评分") },
  tools: { icon: icon(AppWindow), hint: t("这门课的外部工具，和你加的链接") },
  syllabus: { icon: icon(ScrollText), hint: t("大纲的正文") },
};

/** One of the course's own cards that's hidden now (`available`: the course has anything for it). */
export interface HiddenCard {
  entry: Shown & { type: "view" };
  title: string;
  available: boolean;
}

interface Choice {
  key: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  look: Look;
  disabled?: string; // why it can't be added
  pick: () => void;
}

const newId = () => Math.random().toString(36).slice(2, 10);

export function AddCardDialog({ course, hidden, onClose, onAdd }: {
  course: Course;
  hidden: HiddenCard[];
  onClose: () => void;
  onAdd: (card: Shown) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [content, setContent] = useState(false);
  const back = kind && (
    <button onClick={() => setKind(null)} className="mr-auto flex items-center gap-1 self-center text-xs text-muted hover:text-fg">
      <ChevronLeft className="size-3.5" />{t("换一种")}
    </button>
  );
  const input = "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent";

  const own: Choice[] = hidden.flatMap((h) => {
    const o = OWN[h.entry.view];
    return o ? [{
      key: `view:${h.entry.view}`, icon: o.icon, label: h.title, hint: o.hint, look: h.entry.view as Look,
      disabled: h.available ? undefined : t("这门课没有"), pick: () => onAdd(h.entry),
    }] : [];
  });
  const fresh: Choice[] = KINDS.map((k) => ({ key: k.kind, icon: k.icon, label: k.label, hint: k.hint, look: k.kind, pick: () => setKind(k.kind) }));

  return (
    <Dialog
      title={kind ? KINDS.find((k) => k.kind === kind)!.label : t("添加卡片")}
      onClose={onClose}
      width={kind ? "max-w-lg" : "max-w-2xl"}
      footer={kind && (
        <>
          {back}
          <Button onClick={onClose}>{t("取消")}</Button>
          {kind === "note" && <Button primary onClick={() => onAdd({ type: "note", course: course.id, id: newId(), title: title.trim() })}>{t("添加")}</Button>}
          {kind === "search" && (
            <Button primary disabled={!query.trim()} onClick={() => onAdd({ type: "search", query: query.trim(), courses: [course.id], kinds: [], content })}>{t("添加")}</Button>
          )}
        </>
      )}
    >
      {!kind && <Chooser groups={[{ label: t("新卡片"), items: fresh }, { label: t("这门课自带的卡片（隐藏中）"), items: own }]} />}
      {kind === "note" && (
        <label className="block pb-2">
          <span className="mb-1 block text-xs text-muted">{t("标题（可以不填）")}</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("备忘录")} className={input} />
        </label>
      )}
      {(kind === "folder" || kind === "file") && (
        <PathPicker
          root={course.dir}
          files={kind === "file"}
          onPick={(path) => onAdd({ type: kind, path })}
        />
      )}
      {kind === "page" && <PagePicker course={course} onPick={(p) => onAdd({ type: "doc", course: course.id, kind: "page", id: p.id, name: p.title })} />}
      {kind === "module" && <ModulePicker course={course} onPick={(m) => onAdd({ type: "module", course: course.id, module: m.id, name: m.name })} />}
      {kind === "search" && (
        <div className="space-y-3 pb-2">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">{t("搜索内容")}</span>
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("例如：slide this week, hw sol, due today")}
              autoCorrect="off" autoCapitalize="off" spellCheck={false} className={input} />
          </label>
          <label className="flex items-start gap-2 text-xs text-fg-soft">
            <input type="checkbox" className="mt-0.5" checked={content} onChange={(e) => setContent(e.target.checked)} />
            {t("也匹配正文")}
          </label>
        </div>
      )}
    </Dialog>
  );
}

/** What kind of card: a list to type into or arrow through, and beside it a preview of the one
 * pointed at (as Notion shows a block before you add it). */
function Chooser({ groups }: { groups: { label: string; items: Choice[] }[] }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return groups
      .map((g) => ({ ...g, items: g.items.filter((c) => words.every((w) => `${c.label} ${c.hint}`.toLowerCase().includes(w))) }))
      .filter((g) => g.items.length);
  }, [groups, q]);
  const flat = shown.flatMap((g) => g.items);
  const current = flat[Math.min(at, flat.length - 1)];
  useEffect(() => setAt(0), [q]);
  // (void: Chromium's scrollIntoView returns a promise, which React would call as the clean-up)
  useEffect(() => void list.current?.querySelector("[data-current]")?.scrollIntoView({ block: "nearest" }), [at]);
  const step = (d: number) => setAt((i) => (flat.length ? (Math.min(i, flat.length - 1) + d + flat.length) % flat.length : 0));
  const pick = (c: Choice | undefined) => c && !c.disabled && c.pick();

  return (
    <div className="pb-3">
      <input
        autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("筛选…")} autoCorrect="off" spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") (e.preventDefault(), step(e.key === "ArrowDown" ? 1 : -1));
          else if (e.key === "Enter") (e.preventDefault(), pick(current));
        }}
        className="mb-3 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent"
      />
      <div className="flex h-80 gap-4">
        <ul ref={list} className="w-60 shrink-0 overflow-y-auto">
          {!flat.length && <li className="px-2 py-2 text-xs text-muted">{t("没有符合的卡片")}</li>}
          {shown.map((g) => (
            <li key={g.label}>
              <h3 className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted">{g.label}</h3>
              <ul>
                {g.items.map((c) => {
                  const i = flat.indexOf(c);
                  return (
                    <li key={c.key}>
                      <button
                        data-current={c === current ? "" : undefined}
                        onMouseEnter={() => setAt(i)}
                        onClick={() => pick(c)}
                        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${c === current ? "bg-selected" : ""} ${c.disabled ? "text-muted" : ""}`}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-bg text-muted">{c.icon}</span>
                        <span className="truncate">{c.label}</span>
                        {c.disabled && <span className="ml-auto shrink-0 text-[11px] text-muted">{c.disabled}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-1 flex-col rounded-lg bg-bg p-4">
          {current && (
            <>
              <div className="flex flex-1 items-center justify-center">
                <Preview look={current.look} label={current.label} icon={current.icon} />
              </div>
              <p className="mt-3 text-sm font-medium">{current.label}</p>
              <p className="text-xs text-muted">{current.disabled ?? current.hint}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// -- previews: a card, drawn small, with bars standing in for what it would show ---------------

const Bar = ({ w, className = "bg-chip" }: { w: string; className?: string }) => (
  <span aria-hidden className={`block h-1.5 rounded-full ${className}`} style={{ width: w }} />
);
const Line = ({ children }: { children: React.ReactNode }) => <div className="flex items-center gap-2 py-1">{children}</div>;
const W = ["70%", "55%", "80%", "45%", "62%"];

function Preview({ look, label, icon }: { look: Look; label: string; icon: React.ReactNode }) {
  const rows = (n: number, lead?: (i: number) => React.ReactNode, tail?: (i: number) => React.ReactNode) =>
    Array.from({ length: n }, (_, i) => (
      <Line key={i}>{lead?.(i)}<Bar w={W[i % W.length]} />{tail && <span className="ml-auto">{tail(i)}</span>}</Line>
    ));
  const text = (n: number) => <div className="space-y-2 py-1">{Array.from({ length: n }, (_, i) => <Bar key={i} w={i === n - 1 ? "50%" : "100%"} />)}</div>;
  const body = (() => {
    switch (look) {
      case "note": return <div className="rounded-md bg-warn-soft/50 p-2">{text(4)}</div>;
      case "folder": case "files": return rows(4, (i) => <FileIcon name={["a.pdf", "b.pptx", "c.docx", "d.zip"][i]} />, () => <Bar w="1.5rem" />);
      case "file": return <div className="flex h-24 items-center justify-center rounded-md border border-line bg-bg"><FileText className="size-8 text-muted" /></div>;
      case "page": case "syllabus": return <div className="space-y-1"><Bar w="40%" className="bg-fg-soft/40" />{text(4)}</div>;
      case "module": case "modules": return rows(4, () => <ListChecks className="size-3 text-muted" />);
      case "search":
        return (
          <>
            <span className="mb-1 inline-flex items-center gap-1 rounded bg-chip px-1.5 py-0.5 text-[11px] text-fg-soft"><SearchIcon className="size-3" />mt</span>
            {rows(3, (i) => <FileIcon name={["mt1.pdf", "mt1-sol.pdf", "mt2.pdf"][i]} />)}
          </>
        );
      case "assignments": return rows(4, undefined, (i) => <Bar w="2rem" className={i === 0 ? "bg-warn/50" : "bg-chip"} />);
      case "announcements":
        return Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="py-1">
            <Line><span className={`size-1.5 shrink-0 rounded-full ${i === 0 ? "bg-accent" : "bg-transparent"}`} /><Bar w={W[i]} /><span className="ml-auto"><Bar w="1.5rem" /></span></Line>
            <div className="pl-3.5"><Bar w="85%" className="bg-chip/60" /></div>
          </div>
        ));
      case "grades":
        return (
          <>
            <p className="pb-1 text-lg font-semibold tabular-nums">92.5%</p>
            {rows(3, undefined, () => <Bar w="1.75rem" className="bg-ok/40" />)}
          </>
        );
      case "tools":
        return <div className="flex flex-wrap gap-1.5 py-1">{[AppWindow, AppWindow, ScrollText].map((I, i) => (
          <span key={i} className="flex items-center gap-1.5 rounded-md bg-chip/60 px-2 py-1"><I className="size-3 text-muted" /><Bar w="2.5rem" /></span>
        ))}</div>;
    }
  })();
  return (
    <div aria-hidden className="w-64 rounded-xl border border-line bg-panel shadow-sm">
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-xs font-medium">
        <span className="text-muted [&_svg]:size-3.5">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="px-3 pb-3">{body}</div>
    </div>
  );
}

/** Walk the course's folders and pick one (or a file in one). */
function PathPicker({ root, files, onPick }: { root: string; files: boolean; onPick: (path: string) => void }) {
  const [path, setPath] = useState(root);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    setEntries(null);
    void api.tree(path).then((es) => setEntries(es.filter((e) => !e.deleted)), () => setEntries([]));
  }, [path]);
  const parts = path.slice(root.length).split("/").filter(Boolean);
  const shown = (entries ?? []).filter((e) => files || e.type === "dir");
  return (
    <div className="pb-2">
      <nav className="mb-2 flex flex-wrap items-center gap-0.5 text-xs text-muted">
        <button onClick={() => setPath(root)} className="rounded px-1 hover:bg-chip hover:text-fg">{root.split("/").pop()}</button>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <ChevronRight className="size-3" />
            <button onClick={() => setPath([root, ...parts.slice(0, i + 1)].join("/"))} className="rounded px-1 hover:bg-chip hover:text-fg">{p}</button>
          </span>
        ))}
      </nav>
      <ul className="h-64 overflow-y-auto rounded-md border border-line p-1">
        {entries === null && <li><Loading className="px-2 py-2 text-xs" /></li>}
        {entries !== null && shown.length === 0 && <li className="px-2 py-2 text-xs text-muted">{files ? t("这个文件夹是空的") : t("没有子文件夹")}</li>}
        {shown.map((e) => (
          <li key={e.path}>
            <button
              onClick={() => (e.type === "dir" ? setPath(e.path) : onPick(e.path))}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-chip"
            >
              <FileIcon name={e.name} dir={e.type === "dir"} />
              <span className="truncate">{e.name}</span>
              {e.type === "dir" && <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted" />}
            </button>
          </li>
        ))}
      </ul>
      {!files && (
        <div className="mt-2 flex justify-end">
          <Button primary onClick={() => onPick(path)}>{t("用“{name}”", { name: path.split("/").pop() ?? path })}</Button>
        </div>
      )}
    </div>
  );
}

function Filterable<T>({ items, label, onPick, empty }: {
  items: T[] | null;
  label: (x: T) => string;
  onPick: (x: T) => void;
  empty: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (items ?? []).filter((x) => words.every((w) => label(x).toLowerCase().includes(w)));
  }, [items, q, label]);
  return (
    <div className="pb-2">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("筛选…")} autoCorrect="off" spellCheck={false}
        className="mb-2 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent" />
      <ul className="h-64 overflow-y-auto rounded-md border border-line p-1">
        {items === null && <li><Loading className="px-2 py-2 text-xs" /></li>}
        {items !== null && shown.length === 0 && <li className="px-2 py-2 text-xs text-muted">{empty}</li>}
        {shown.map((x, i) => (
          <li key={i}>
            <button onClick={() => onPick(x)} className="w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-chip">{label(x)}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PagePicker({ course, onPick }: { course: Course; onPick: (p: ItemSummary) => void }) {
  const [pages, setPages] = useState<ItemSummary[] | null>(null);
  useEffect(() => void api.items(course.id, "page").then(setPages, () => setPages([])), [course.id]);
  return <Filterable items={pages} label={(p) => p.title} onPick={onPick} empty={t("这门课没有页面")} />;
}

function ModulePicker({ course, onPick }: { course: Course; onPick: (m: Module) => void }) {
  const [modules, setModules] = useState<Module[] | null>(null);
  useEffect(() => void api.modules(course.id).then(setModules, () => setModules([])), [course.id]);
  return <Filterable items={modules} label={(m) => m.name} onPick={onPick} empty={t("这门课没有模块")} />;
}
