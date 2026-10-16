// A course's page: tabs (概览 first), the overview, and readers for announcements,
// assignments, pages and the syllabus. The 文件 tab is the file browser, rendered by
// the main window.
import { ClipboardList, ExternalLink, FileText, FolderOpen, Megaphone, Paperclip, ScrollText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import type { Course, DocKind, Item, ItemSummary, Overview } from "../lib/api";
import { shortDate, untilDue } from "../lib/dates";
import { fileManager } from "../lib/keys";
import { FileIcon } from "./FileIcon";
import { RichText, type CourseLink } from "./RichText";

export type CourseTab = "overview" | "announcements" | "assignments" | "files" | "syllabus" | "pages";

export const TAB_OF_KIND: Record<DocKind, CourseTab> = {
  announcement: "announcements", assignment: "assignments", page: "pages", syllabus: "syllabus",
};
const KIND_OF_TAB: Partial<Record<CourseTab, DocKind>> = {
  announcements: "announcement", assignments: "assignment", pages: "page", syllabus: "syllabus",
};

/** The overview, loaded once per course and version (it also says which tabs to show). */
export function useOverview(courseId: number | null, version: number) {
  const [data, setData] = useState<{ id: number; overview: Overview } | null>(null);
  useEffect(() => {
    if (courseId === null) return;
    let live = true;
    api.overview(courseId).then((o) => live && setData({ id: courseId, overview: o }), () => {});
    return () => {
      live = false;
    };
  }, [courseId, version]);
  return data && data.id === courseId ? data.overview : null;
}

export function CourseTabs({ tab, overview, onTab }: { tab: CourseTab; overview: Overview | null; onTab: (t: CourseTab) => void }) {
  const c = overview?.counts;
  // Tabs with nothing in them aren't shown; 概览 and 文件 always are.
  const tabs: [CourseTab, string, boolean][] = [
    ["overview", "概览", true],
    ["announcements", "公告", !!c?.announcements],
    ["assignments", "作业", !!c?.assignments],
    ["files", "文件", true],
    ["syllabus", "大纲", !!c?.syllabus],
    ["pages", "页面", !!c?.pages],
  ];
  return (
    <nav className="flex gap-1 border-b border-line px-4" aria-label="课程">
      {tabs.filter(([t, , shown]) => shown || t === tab).map(([t, label]) => (
        <button
          key={t}
          onClick={() => onTab(t)}
          aria-current={tab === t ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

// -- 概览 --------------------------------------------------------------------------------

export function CourseOverview({ course, overview, onOpen, onTab }: {
  course: Course;
  overview: Overview | null;
  onOpen: (kind: DocKind, id: string) => void;
  onTab: (t: CourseTab) => void;
}) {
  if (!overview) return <p className="px-6 py-8 text-sm text-muted">正在加载…</p>;
  const { upcoming, announcements, new_files, counts } = overview;
  const empty = !counts.announcements && !counts.assignments && !counts.pages && !counts.files && !counts.syllabus;
  if (empty) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-sm text-fg-soft">
        <p className="mb-2 text-base text-fg">这门课在 Canvas 上几乎没有内容。</p>
        <p className="text-muted">很多课程把材料放在课程网站、Ed 或 Gradescope 上。</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-4 text-accent hover:underline">在 Canvas 中打开这门课</button>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-5xl gap-4 p-6 lg:grid-cols-2">
        <Card title="近期截止" icon={<ClipboardList className="size-4" />} more={counts.assignments ? () => onTab("assignments") : undefined}>
          {upcoming.length === 0 ? (
            <Empty>接下来三周没有要交的作业</Empty>
          ) : (
            upcoming.map((a) => <AssignmentRow key={a.id} a={a} onClick={() => onOpen("assignment", a.id)} />)
          )}
        </Card>
        <Card title="最新公告" icon={<Megaphone className="size-4" />} more={counts.announcements ? () => onTab("announcements") : undefined}>
          {announcements.length === 0 ? (
            <Empty>还没有公告</Empty>
          ) : (
            announcements.map((a) => (
              <Row key={a.id} onClick={() => onOpen("announcement", a.id)}>
                <div className="flex items-baseline gap-2">
                  {a.unread && <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-accent" aria-label="未读" />}
                  <span className="truncate font-medium">{a.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(a.date, false)}</span>
                </div>
                {a.preview && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{a.preview}</p>}
              </Row>
            ))
          )}
        </Card>
        <Card title="最近新增的文件" icon={<FileText className="size-4" />} more={() => onTab("files")}>
          {new_files.length === 0 ? (
            <Empty>还没有文件</Empty>
          ) : (
            new_files.map((f) => (
              <Row key={f.file_id} onClick={() => void api.openPath(f.path)}>
                <div className="flex items-center gap-2">
                  <FileIcon name={f.name} />
                  <span className="truncate">{f.name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(f.date, false)}</span>
                  <button
                    title={`在 ${fileManager} 中显示`}
                    aria-label={`在 ${fileManager} 中显示`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.openPath(f.path, { reveal: true });
                    }}
                    className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
                  >
                    <FolderOpen className="size-3.5" />
                  </button>
                </div>
              </Row>
            ))
          )}
        </Card>
        <Card title="链接" icon={<ExternalLink className="size-4" />}>
          {counts.syllabus && (
            <Row onClick={() => onTab("syllabus")}>
              <span className="flex items-center gap-2"><ScrollText className="size-4 text-muted" />课程大纲</span>
            </Row>
          )}
          <Row onClick={() => void api.openUrl(`/courses/${course.id}`)}>
            <span className="flex items-center gap-2"><ExternalLink className="size-4 text-muted" />在 Canvas 中打开</span>
          </Row>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, icon, more, children }: { title: string; icon: React.ReactNode; more?: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex items-center gap-2 px-4 pt-3 pb-1.5 text-sm font-medium">
        <span className="text-muted">{icon}</span>
        {title}
        {more && <button onClick={more} className="ml-auto text-xs font-normal text-muted hover:text-fg">全部 ›</button>}
      </header>
      <div className="px-2 pb-2">{children}</div>
    </section>
  );
}

function Row({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === "Enter" && onClick()} className="cursor-default rounded-md px-2 py-1.5 text-sm hover:bg-chip">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-3 text-sm text-muted">{children}</p>;
}

function Due({ iso }: { iso: string | null | undefined }) {
  const due = untilDue(iso);
  if (!due) return <span className="text-xs text-muted">没有截止日期</span>;
  return (
    <span className={`text-xs ${due.urgent ? "font-medium text-warn" : "text-muted"}`}>
      {shortDate(iso)} · {due.text}
    </span>
  );
}

function AssignmentRow({ a, onClick, selected }: { a: ItemSummary; onClick: () => void; selected?: boolean }) {
  return (
    <Row onClick={onClick}>
      <div className={`flex items-baseline gap-2 ${selected ? "font-medium" : ""}`}>
        <span className="truncate">{a.title}</span>
        <span className="ml-auto shrink-0"><Due iso={a.due_at} /></span>
      </div>
    </Row>
  );
}

// -- 公告 / 作业 / 页面 / 大纲 --------------------------------------------------------------

/** A list on the left, the selected item on the right, like a mail client. */
export function CourseReader({ course, tab, selected, version, onSelect, onNavigate }: {
  course: Course;
  tab: CourseTab;
  selected: string | null;
  version: number;
  onSelect: (id: string) => void;
  onNavigate: (to: CourseLink) => void;
}) {
  const kind = KIND_OF_TAB[tab]!;
  const [list, setList] = useState<ItemSummary[] | null>(null);
  useEffect(() => {
    setList(null);
    api.items(course.id, kind).then(setList, () => setList([]));
  }, [course.id, kind, version]);

  // Nothing chosen yet: the newest announcement, the next assignment, the front page.
  const current = selected ?? list?.[0]?.id ?? null;

  if (kind === "syllabus") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ItemView course={course} kind="syllabus" id={String(course.id)} version={version} onNavigate={onNavigate} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <ul className="w-80 shrink-0 overflow-y-auto border-r border-line p-2" aria-label="列表">
        {list === null && <li className="px-2 py-3 text-sm text-muted">正在加载…</li>}
        {list?.length === 0 && <li className="px-2 py-3 text-sm text-muted">什么都没有</li>}
        {kind === "assignment" ? <AssignmentList list={list ?? []} current={current} onSelect={onSelect} /> : (list ?? []).map((it) => (
          <ListRow key={it.id} it={it} active={it.id === current} onClick={() => onSelect(it.id)} />
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {current && <ItemView key={`${kind}:${current}`} course={course} kind={kind} id={current} version={version} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}

function ListRow({ it, active, onClick }: { it: ItemSummary; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button onClick={onClick} className={`block w-full rounded-md px-2.5 py-2 text-left ${active ? "bg-selected" : "hover:bg-chip"}`}>
        <div className="flex items-baseline gap-2">
          {it.unread && <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-accent" aria-label="未读" />}
          <span className={`truncate text-sm ${it.unread ? "font-medium" : ""}`}>{it.title}</span>
          {it.front_page && <span className="shrink-0 rounded bg-chip px-1 text-[10px] text-muted">首页</span>}
          <span className="ml-auto shrink-0 text-xs text-muted">{shortDate(it.date, false)}</span>
        </div>
        {it.preview && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{it.preview}</p>}
        {it.author && !it.preview && <p className="mt-0.5 text-xs text-muted">{it.author}</p>}
      </button>
    </li>
  );
}

function AssignmentList({ list, current, onSelect }: { list: ItemSummary[]; current: string | null; onSelect: (id: string) => void }) {
  const groups = useMemo(() => {
    const now = Date.now();
    const g: [string, ItemSummary[]][] = [["即将截止", []], ["已过截止", []], ["没有截止日期", []]];
    for (const a of list) {
      const t = a.due_at ? new Date(a.due_at).getTime() : null;
      g[t === null ? 2 : t >= now ? 0 : 1][1].push(a);
    }
    return g.filter(([, xs]) => xs.length);
  }, [list]);
  return (
    <>
      {groups.map(([name, xs]) => (
        <li key={name}>
          <h3 className="px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted">{name}</h3>
          <ul>
            {xs.map((a) => (
              <li key={a.id}>
                <button onClick={() => onSelect(a.id)} className={`block w-full rounded-md px-2.5 py-2 text-left ${a.id === current ? "bg-selected" : "hover:bg-chip"}`}>
                  <div className="truncate text-sm">{a.title}</div>
                  <div className="mt-0.5 flex gap-2"><Due iso={a.due_at} />{a.points != null && <span className="text-xs text-muted">· {a.points} 分</span>}</div>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </>
  );
}

const SUBMISSION: Record<string, string> = {
  online_upload: "上传文件", online_text_entry: "在线文本", online_url: "网址", online_quiz: "测验",
  discussion_topic: "讨论", external_tool: "外部工具", on_paper: "纸质", none: "不需要提交", media_recording: "录音/录像",
};

function ItemView({ course, kind, id, version, onNavigate }: {
  course: Course;
  kind: DocKind;
  id: string;
  version: number;
  onNavigate: (to: CourseLink) => void;
}) {
  const [it, setIt] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setIt(null);
    setError(null);
    api.item(course.id, kind, id).then(setIt, (e) => setError(e.message));
  }, [course.id, kind, id, version]);

  if (error) {
    return (
      <div className="p-8 text-sm text-fg-soft">
        <p>在已同步的内容里找不到它（可能是新的，或者不是公告）。</p>
        <button onClick={() => void api.openUrl(`/courses/${course.id}`)} className="mt-2 text-accent hover:underline">在 Canvas 中打开这门课</button>
      </div>
    );
  }
  if (!it) return <p className="p-8 text-sm text-muted">正在加载…</p>;
  const submit = kind === "assignment" && it.submission_types?.some((t) => t.startsWith("online") || t === "external_tool");
  return (
    <article className="mx-auto max-w-3xl px-8 py-6">
      <header className="mb-4 border-b border-line pb-4">
        <h1 className="selectable text-xl font-semibold">{kind === "syllabus" ? "课程大纲" : it.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {kind === "announcement" && <>{it.author && <span>{it.author}</span>}<span>{shortDate(it.date)}</span></>}
          {kind === "assignment" && (
            <>
              <Due iso={it.due_at} />
              {it.points != null && <span>{it.points} 分</span>}
              {!!it.submission_types?.length && <span>{it.submission_types.map((t) => SUBMISSION[t] ?? t).join("、")}</span>}
            </>
          )}
          {kind === "page" && it.date && <span>更新于 {shortDate(it.date)}</span>}
          {it.url && (
            <button onClick={() => void api.openUrl(it.url!)} className="ml-auto flex items-center gap-1 text-accent hover:underline">
              {submit ? "在 Canvas 中提交" : "在 Canvas 中打开"}
              <ExternalLink className="size-3.5" />
            </button>
          )}
        </div>
      </header>
      {it.attachments.length > 0 && (
        <ul className="mb-4 flex flex-wrap gap-2">
          {it.attachments.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => void (a.path ? api.openPath(a.path) : api.openUrl(`/courses/${course.id}/files/${a.id}`))}
                className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:bg-chip"
              >
                <Paperclip className="size-3.5 text-muted" />
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {it.html.trim() ? (
        <RichText html={it.html} courseId={course.id} files={it.files} onNavigate={onNavigate} />
      ) : (
        <p className="text-sm text-muted">没有正文。</p>
      )}
    </article>
  );
}
