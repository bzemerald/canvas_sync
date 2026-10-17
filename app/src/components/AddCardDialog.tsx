// Adding a card to a course's overview: what kind, then which folder, file, page, module, or
// what to search for. (Anything can also be dragged onto the overview.)
import { BookOpen, ChevronLeft, ChevronRight, FileText, Folder, ListChecks, NotebookPen, ScrollText, Search as SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import type { Course, Entry, ItemSummary, Module } from "../lib/api";
import { t } from "../lib/i18n";
import { type Shown, isView, view } from "../lib/things";
import { Button, Dialog } from "./Dialog";
import { FileIcon } from "./FileIcon";

type Kind = "note" | "folder" | "file" | "page" | "module" | "search" | "syllabus";

const KINDS: { kind: Kind; icon: React.ReactNode; label: string; hint: string }[] = [
  { kind: "note", icon: <NotebookPen className="size-5" />, label: t("备忘录"), hint: t("随手记：考试范围、办公时间、要问老师的问题") },
  { kind: "folder", icon: <Folder className="size-5" />, label: t("文件夹"), hint: t("某个文件夹里的文件，比如讲义或作业") },
  { kind: "file", icon: <FileText className="size-5" />, label: t("文件@@card"), hint: t("一个常看的文件，比如课程表、公式表") },
  { kind: "page", icon: <BookOpen className="size-5" />, label: t("页面@@card"), hint: t("Canvas 上的某个页面，比如老师更新进度的那页") },
  { kind: "module", icon: <ListChecks className="size-5" />, label: t("模块@@card"), hint: t("固定显示某个模块，比如考试复习") },
  { kind: "search", icon: <SearchIcon className="size-5" />, label: t("搜索"), hint: t("这门课里名字符合条件的东西，比如“mt”") },
  { kind: "syllabus", icon: <ScrollText className="size-5" />, label: t("课程大纲"), hint: t("大纲的正文") },
];

const newId = () => Math.random().toString(36).slice(2, 10);

export function AddCardDialog({ course, shown, onClose, onAdd }: {
  course: Course;
  shown: Shown[]; // the cards on the overview now
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

  return (
    <Dialog
      title={kind ? KINDS.find((k) => k.kind === kind)!.label : t("添加卡片")}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          {back}
          <Button onClick={onClose}>{t("取消")}</Button>
          {kind === "note" && <Button primary onClick={() => onAdd({ type: "note", course: course.id, id: newId(), title: title.trim() })}>{t("添加")}</Button>}
          {kind === "search" && (
            <Button primary disabled={!query.trim()} onClick={() => onAdd({ type: "search", query: query.trim(), courses: [course.id], kinds: [], content })}>{t("添加")}</Button>
          )}
        </>
      }
    >
      {!kind && (
        <ul className="grid grid-cols-2 gap-2 pb-2">
          {KINDS.map((k) => {
            const taken = k.kind === "syllabus" && shown.some((c) => isView(c, "syllabus"));
            return (
              <li key={k.kind}>
                <button
                  disabled={taken}
                  onClick={() => (k.kind === "syllabus" ? onAdd(view(course.id, "syllabus")) : setKind(k.kind))}
                  className="flex h-full w-full gap-3 rounded-lg border border-line p-3 text-left hover:bg-chip disabled:opacity-40"
                >
                  <span className="text-muted">{k.icon}</span>
                  <span>
                    <span className="block text-sm font-medium">{k.label}</span>
                    <span className="block text-xs text-muted">{taken ? t("已经有了") : k.hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
            <span className="mb-1 block text-xs text-muted">{t("搜索内容（和搜索框一样，可以用课程名和缩写）")}</span>
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("例如：mt1、hw sol、期中")}
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
        {entries === null && <li className="px-2 py-2 text-xs text-muted">{t("正在加载…")}</li>}
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
        {items === null && <li className="px-2 py-2 text-xs text-muted">{t("正在加载…")}</li>}
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
