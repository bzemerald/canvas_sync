// What search finds (lib/find.ts), shown the Spotlight way: the best of all on top, then groups
// (courses, pages and tools, assignments, announcements, files and folders, things to do, what's
// only inside), a few of each until asked for all; before anything is typed, what you opened
// lately and what's due soon. Shared by the search window and the main window's 搜索 page,
// inside a cmdk <Command> (arrows move, enter opens).
import { Command } from "cmdk";
import { AppWindow, RefreshCw, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type { CatalogEntry, Course, Hit, Usage } from "../lib/api";
import { untilDue } from "../lib/dates";
import { en } from "../lib/en";
import { type Action, type Catalog, type Describe, type Found, type GroupId, type Results, dueSoon, find, prepare, recent } from "../lib/find";
import { t } from "../lib/i18n";
import { isMac } from "../lib/keys";
import type { ViewName } from "../lib/things";
import { useLoaded } from "../lib/useLoaded";
import { KIND, ResultBody, Snippet, formatDate } from "./Result";
import { ThingIcon, thingName, useThing } from "./Things";

/** One of the app's words as it's said in each language (en.ts has the English). */
function inBoth(zh: string): string[] {
  const e = en[zh];
  return [zh.split("@@")[0], ...(e === undefined ? [] : typeof e === "string" ? [e] : e)];
}

// What else a course's views answer to: their names as tabs and as cards, in both languages.
const VIEW_WORDS: Record<ViewName, string[]> = {
  overview: ["概览"], // i18n-ignore
  modules: ["模块", "当前模块"], // i18n-ignore
  announcements: ["公告", "最新公告"], // i18n-ignore
  assignments: ["作业", "近期截止"], // i18n-ignore
  grades: ["成绩"], // i18n-ignore
  files: ["文件", "最近新增的文件"], // i18n-ignore
  syllabus: ["大纲", "课程大纲"], // i18n-ignore
  pages: ["页面"], // i18n-ignore
  tools: ["工具与链接"], // i18n-ignore
  canvas: ["在 Canvas 中打开"], // i18n-ignore
};
// What kind of thing it is, in both languages: "cs70 公告" finds CS 70's announcements by name.
const KIND_WORDS: Record<string, string> = {
  course: "课程", // i18n-ignore
  announcement: "公告", // i18n-ignore
  assignment: "作业", // i18n-ignore
  page: "页面@@card", // i18n-ignore
  module: "模块@@card", // i18n-ignore
  tool: "外部工具", // i18n-ignore
  link: "链接", // i18n-ignore
  note: "备忘录", // i18n-ignore
  search: "智能文件夹", // i18n-ignore
  file: "文件@@card", // i18n-ignore
  folder: "文件夹", // i18n-ignore
};

/** What things are called, for finding them (see find.ts). `courses`: for their names as shown. */
export const describeEntry = (courses: Course[]): Describe => (e) => {
  const aliases = [...e.aliases];
  if (e.type === "view") aliases.push(...VIEW_WORDS[e.view].flatMap(inBoth));
  else if (e.type === "note" && e.text) aliases.push(e.text);
  else if (e.type === "link") aliases.push(e.url.replace(/^https?:\/\/(www\.)?/, ""));
  else if (e.type === "search") aliases.push(e.query);
  const kind = e.type === "doc" ? e.kind : e.type;
  return { names: [thingName(e, courses), e.name ?? ""], aliases, kind: KIND_WORDS[kind] ? inBoth(KIND_WORDS[kind]) : [] };
};

// Where a course's views are on Canvas.
const VIEW_PATH: Record<ViewName, string> = {
  overview: "", modules: "/modules", announcements: "/announcements", assignments: "/assignments", grades: "/grades",
  files: "/files", syllabus: "/assignments/syllabus", pages: "/pages", tools: "", canvas: "",
};

/** Where it is on Canvas, if anywhere (a link, a note, a smart folder: nowhere). */
export function canvasUrl(e: CatalogEntry): string | null {
  if (e.canvas_url) return e.canvas_url;
  if (e.type === "view") return `/courses/${e.course}${VIEW_PATH[e.view]}`;
  if (e.type === "folder" && e.in_course !== null) return `/courses/${e.in_course}/files`;
  return null;
}

const NOTHING: Usage = { opened: {}, picks: [] };

/** The catalog, made ready for finding, and what you open; loaded again when `again` changes. */
export function useCatalog(again: unknown[], courses: Course[] = []) {
  const data = useLoaded("catalog", api.catalog, again).value;
  const catalog = useMemo(() => (data ? prepare(data.things, describeEntry(courses)) : null), [data, courses]);
  const names = useMemo(
    () => new Map((data?.things ?? []).flatMap((e) => (e.type === "course" ? [[e.course, e.name ?? ""] as const] : []))),
    [data],
  );
  return { catalog, usage: data ?? NOTHING, names };
}

/** Things to do from search: sync everything or one course, settings, a new smart folder. */
export function actionsFor(names: Map<number, string>, extra: Action[] = []): Action[] {
  return [
    { id: "sync", label: t("同步全部课程"), names: [t("同步全部课程"), ...inBoth("同步")] }, // i18n-ignore
    ...[...names].map(([course, name]) => ({ id: `sync:${course}`, label: t("同步 {name}", { name }), names: inBoth("同步"), course })), // i18n-ignore
    { id: "settings", label: t("打开设置"), names: [t("打开设置"), ...inBoth("设置")] }, // i18n-ignore
    { id: "smart-folder", label: t("新建智能文件夹…"), names: inBoth("新建智能文件夹…") }, // i18n-ignore
    ...extra,
  ];
}

const EMPTY = prepare([], () => ({ names: [], aliases: [], kind: [] }));

/** What's listed for `query` (or, with none, what you opened lately and what's due soon), each by
 * key, and which comes first. */
export function useFound(query: string, catalog: Catalog | null, usage: Usage, hits: Hit[], actions: Action[]) {
  const results = useMemo(() => (query.trim() ? find(query, catalog ?? EMPTY, usage, hits, actions) : null), [query, catalog, usage, hits, actions]);
  const lately = useMemo(() => (catalog ? recent(catalog, usage) : []), [catalog, usage]);
  const due = useMemo(() => (catalog ? dueSoon(catalog) : []), [catalog]);
  const listed = useMemo(() => {
    const all = results ? [...(results.top ? [results.top] : []), ...results.groups.flatMap((g) => g.items)] : [...lately, ...due];
    return new Map(all.map((f) => [f.key, f]));
  }, [results, lately, due]);
  const first = results ? results.top?.key ?? results.groups[0]?.items[0]?.key ?? "" : lately[0]?.key ?? due[0]?.key ?? "";
  return { results, lately, due, listed, first, nothing: !!results && !results.top && !results.groups.length };
}

export type How = "open" | "reveal" | "canvas"; // ↵, ⌘↵ (in its folder), ⌘⇧↵ (on Canvas)

/** Which one is chosen (cmdk's value): the one you moved to, while you're still on the same
 * query and it's still there; else the first. (Chosen a moment late, the list would first scroll
 * to the one chosen for what was typed before.) And the list, back at its top on a new query. */
export function useChosen(query: string, listed: Map<string, Found>, first: string) {
  const [chosen, setChosen] = useState({ query, key: "" });
  const value = chosen.query === query && listed.has(chosen.key) ? chosen.key : first;
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [query]);
  return { value, choose: (key: string) => setChosen({ query, key }), list };
}

/** ⌘↵ and ⌘⇧↵ on the chosen one. */
export function moreKeys(e: React.KeyboardEvent, chosen: () => Found | undefined, open: (f: Found | undefined, how: How) => void): boolean {
  if (e.key !== "Enter" || !(isMac ? e.metaKey : e.ctrlKey)) return false;
  e.preventDefault();
  open(chosen(), e.shiftKey ? "canvas" : "reveal");
  return true;
}

/** The main window's 搜索 page: `input` above, what it finds below. */
export function FoundSearch({ input, query, hits, catalog, usage, names, courses, actions, onOpen, props, welcome }: {
  input: React.ReactNode;
  query: string;
  hits: Hit[];
  catalog: Catalog | null;
  usage: Usage;
  names: Map<number, string>;
  courses: Course[];
  actions: Action[];
  onOpen: (f: Found | undefined, how: How) => void;
  props?: (f: Found) => object;
  welcome: React.ReactNode; // with nothing typed and nothing to show
}) {
  const { results, lately, due, listed, first, nothing } = useFound(query, catalog, usage, hits, actions);
  const { value, choose, list } = useChosen(query, listed, first);
  return (
    <Command shouldFilter={false} loop value={value} onValueChange={choose} className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => moreKeys(e, () => listed.get(value), onOpen)}>
      <div className="border-b border-line px-6 py-3">{input}</div>
      <Command.List ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {query.trim() && nothing && <Command.Empty className="px-2 py-10 text-center text-sm text-muted">{t("没有结果")}</Command.Empty>}
        {!query.trim() && !lately.length && !due.length && welcome}
        <FoundList results={results} recent={lately} due={due} courses={courses} names={names} onOpen={(f) => onOpen(f, "open")} props={props} />
      </Command.List>
    </Command>
  );
}

const ACTION_ICON = { sync: RefreshCw, settings: SettingsIcon, "smart-folder": Sparkles, main: AppWindow };

const GROUP: Record<GroupId, string> = {
  courses: t("课程@@group"), places: t("页面与工具"), assignments: t("作业"), announcements: t("公告"), files: t("文件与文件夹"),
  actions: t("操作"), inside: t("正文中提到"),
};
const MOST = 50;

const heading = "px-2 pt-2 pb-1 text-xs font-medium text-muted";
const itemClass = "cursor-default rounded-lg px-3 py-2 data-[selected=true]:bg-selected";

/** The list: `results` for what's typed, or (null) what you opened lately and what's due soon.
 * `props`: more for an item (dragging it, right-clicking it). */
export function FoundList({ results, recent, due, courses, names, onOpen, props }: {
  results: Results | null;
  recent: Found[];
  due: Found[];
  courses: Course[];
  names: Map<number, string>; // courses' names, by id
  onOpen: (f: Found) => void;
  props?: (f: Found) => object;
}) {
  const [all, setAll] = useState<Set<GroupId>>(new Set()); // groups shown in full
  useEffect(() => setAll(new Set()), [results]);
  const thing = useThing(); // (drag it somewhere, right-click it: in the main window)
  const item = (f: Found, top = false) => (
    <Command.Item key={f.key} value={f.key} onSelect={() => onOpen(f)} className={itemClass}
      {...(f.type === "thing" ? thing(f.entry) : {})} {...props?.(f)}>
      <FoundRow f={f} courses={courses} names={names} top={top} />
    </Command.Item>
  );

  if (!results) {
    return (
      <>
        {recent.length > 0 && <Command.Group heading={t("最近打开")} className={heading}>{recent.map((f) => item(f))}</Command.Group>}
        {due.length > 0 && <Command.Group heading={t("近期截止")} className={heading}>{due.map((f) => item(f))}</Command.Group>}
      </>
    );
  }
  return (
    <>
      {results.top && <Command.Group heading={t("最佳结果")} className={heading}>{item(results.top, true)}</Command.Group>}
      {results.groups.map((g) => {
        const shown = all.has(g.id) ? g.items.slice(0, MOST) : g.items.slice(0, g.cap);
        const more = g.items.length - shown.length;
        return (
          <Command.Group key={g.id} heading={GROUP[g.id]} className={heading}>
            {shown.map((f) => item(f))}
            {more > 0 && !all.has(g.id) && (
              <Command.Item value={`more:${g.id}`} onSelect={() => setAll((s) => new Set(s).add(g.id))}
                className={`${itemClass} py-1.5 text-xs text-muted`}>
                {t("还有 {n} 项 ›", { n: more })}
              </Command.Item>
            )}
          </Command.Group>
        );
      })}
    </>
  );
}

/** One thing found: its icon and name, the course it's in, what it is, when; what matched inside. */
function FoundRow({ f, courses, names, top }: { f: Found; courses: Course[]; names: Map<number, string>; top: boolean }) {
  if (f.type === "hit") return <ResultBody hit={f.hit} />;
  if (f.type === "action") {
    const Icon = ACTION_ICON[f.action.id.split(":")[0] as keyof typeof ACTION_ICON] ?? Sparkles;
    return (
      <div className="flex items-center gap-3">
        <Icon className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="truncate text-fg">{f.action.label}</span>
      </div>
    );
  }
  const e = f.entry;
  const course = e.in_course !== null && e.type !== "course" ? names.get(e.in_course) : undefined;
  const what = describeKind(e);
  const due = e.type === "doc" && e.kind === "assignment" ? untilDue(e.due) : null;
  const date = !due && e.date && (e.type === "doc" || e.type === "file") ? formatDate(e.date) : "";
  return (
    <div className="flex min-w-0 gap-3">
      <span className={`mt-0.5 shrink-0 text-muted ${top ? "[&_svg]:size-5" : ""}`}><ThingIcon thing={e} courses={courses} /></span>
      <div className="min-w-0 flex-1">
        <div className={`truncate text-fg ${top ? "text-base font-medium" : "font-medium"}`}>{thingName(e, courses)}</div>
        {(course || what || due || date) && (
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
            {course && <span className="shrink-0 rounded bg-chip px-1.5 py-px text-fg-soft">{course}</span>}
            {what && <span className="truncate">{what}</span>}
            {due && <span className={`shrink-0 ${due.urgent ? "font-medium text-warn" : ""}`}>· {due.text}</span>}
            {date && <span className="shrink-0">· {date}</span>}
          </div>
        )}
        {f.hit && <Snippet hit={f.hit} />}
      </div>
    </div>
  );
}

/** What a thing is, in a few words: its kind, or where it is. */
function describeKind(e: CatalogEntry): string {
  switch (e.type) {
    case "course": return t("课程");
    case "doc": return KIND[e.kind].label;
    case "module": return t("模块@@card");
    case "tool": return t("外部工具");
    case "link": return e.url.replace(/^https?:\/\/(www\.)?/, "");
    case "note": return e.text || t("备忘录");
    case "search": return t("智能文件夹");
    case "file": case "folder": return e.path.split("/").slice(2, -1).join(" / ");
    default: return "";
  }
}
