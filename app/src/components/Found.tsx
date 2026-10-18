// What search finds (lib/find.ts), shown the Spotlight way: the best of all on top, then groups
// (courses, pages and tools, assignments, announcements, files and folders, things to do, what's
// only inside), a few of each until asked for all; before anything is typed, what you opened
// lately and what's due soon. Above it, how what's typed was read (lib/query.ts): a chip for each
// part that narrows it down. Shared by the search window, the main window's 搜索 page and its search
// box elsewhere (in a course, in a folder: `Scope`), inside a cmdk <Command> (arrows move, enter
// opens). And the same, narrowing a list (a course's tab) as you type: `useNarrowing`.
import { Command } from "cmdk";
import { AppWindow, CalendarDays, CircleCheck, MessagesSquare, RefreshCw, Settings as SettingsIcon, Sparkles, X } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type { CatalogEntry, Course, Usage } from "../lib/api";
import { shortDate, untilDue } from "../lib/dates";
import { en } from "../lib/en";
import { type Action, type Catalog, type Describe, type Found, type GroupId, type Results, type Scope, dueSoon, find, narrow, prepare, recent, vocabulary } from "../lib/find";
import { locale, t, tx } from "../lib/i18n";
import { isMac } from "../lib/keys";
import { type KindId, NO_VOCABULARY, type Part, type PartOf, type Reading, type Vocabulary, asText, corrected, indexQuery, key, read, singular, without } from "../lib/query";
import type { Thing, ViewName } from "../lib/things";
import { useLoaded } from "../lib/useLoaded";
import { useAnswer } from "../lib/useSearch";
import { KIND, ResultBody, Snippet, formatDate } from "./Result";
import { SourceTag, ThingIcon, thingName, useThing } from "./Things";

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
  discussion: ["讨论", "讨论区", "帖子"], // i18n-ignore
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
  post: "帖子", // i18n-ignore
  module: "模块@@card", // i18n-ignore
  tool: "外部工具", // i18n-ignore
  link: "链接", // i18n-ignore
  note: "备忘录", // i18n-ignore
  search: "智能文件夹", // i18n-ignore
  file: "文件@@card", // i18n-ignore
  folder: "文件夹", // i18n-ignore
};
// The words a query says a kind of thing by (both languages, as the app says them; one word each).
const KIND_SAID: Record<KindId, string[]> = {
  course: ["课程"], announcement: ["公告"], assignment: ["作业"], page: ["页面", "页面@@card"], post: ["帖子", "讨论", "thread"], module: ["模块", "模块@@card"], // i18n-ignore
  tool: ["外部工具", "工具"], link: ["链接"], note: ["备忘录"], search: ["智能文件夹"], file: ["文件", "文件@@card"], folder: ["文件夹"], // i18n-ignore
};
const KINDS: Record<string, KindId> = Object.fromEntries(
  (Object.entries(KIND_SAID) as [KindId, string[]][]).flatMap(([kind, zh]) =>
    [...zh.flatMap(inBoth), kind].map((w) => w.toLowerCase()).filter((w) => !w.includes(" ")).map((w) => [singular(w), kind])),
);

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
  overview: "", modules: "/modules", announcements: "/announcements", discussion: "", assignments: "/assignments", grades: "/grades",
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

/** The catalog, made ready for finding, what reading a query knows of it, and what you open;
 * loaded again when `again` changes (and only while `on`: what was loaded last stays). */
export function useCatalog(again: unknown[], courses: Course[] = [], on = true) {
  const data = useLoaded(on ? "catalog" : null, api.catalog, again).value;
  const catalog = useMemo(() => (data ? prepare(data.things, describeEntry(courses), data.abbreviations) : null), [data, courses]);
  const vocab = useMemo(() => (catalog ? vocabulary(catalog, KINDS) : NO_VOCABULARY), [catalog]);
  const names = useMemo(
    () => new Map((data?.things ?? []).flatMap((e) => (e.type === "course" ? [[e.course, e.name ?? ""] as const] : []))),
    [data],
  );
  return { catalog, vocab, usage: data ?? NOTHING, names };
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

// The course you were last in, in the main window (both windows see it: they share storage).
const LAST_COURSE = "pref:last-course";
export function rememberCourse(id: number) {
  try {
    localStorage.setItem(LAST_COURSE, String(id));
  } catch {
    /* not remembered: search just doesn't put it first */
  }
}
function lastCourse(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_COURSE));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

const EMPTY = prepare([], () => ({ names: [], aliases: [], kind: [] }));
const NO_ANSWER: api.FoundInText = { hits: [], corrected: {} };
const NOWHERE: Scope = {};

/** What's found for `query`, as you type: how it reads, what that finds by name and in the index
 * (or, with nothing typed, what you opened lately and what's due soon), each by key, and which
 * comes first. `scope`: where it's searched from (a course; a folder), unless what's typed names
 * a course. */
export function useFinding(query: string, catalog: Catalog | null, vocab: Vocabulary, usage: Usage, actions: Action[], scope: Scope = NOWHERE) {
  const typed = useMemo(() => read(query, vocab), [query, vocab]);
  const where = typed.parts.some((p) => p.role === "course") ? NOWHERE : scope;
  const asked = useMemo(() => {
    const q = indexQuery(typed, catalog?.abbreviations ?? {});
    return q && { ...q, courses: q.courses.length ? q.courses : where.courses ?? [], under: where.under };
  }, [typed, catalog, where]);
  const { answer, error, loading } = useAnswer(asked ? JSON.stringify(asked) : "", () =>
    asked ? api.find(asked.q, { ...asked, limit: 40 }) : Promise.resolve(NO_ANSWER), NO_ANSWER);
  // Misspelled words (the index has nothing they start) are taken for the nearest there are.
  const reading = useMemo(() => corrected(typed, answer.corrected), [typed, answer]);
  const hits = answer.hits;
  const results = useMemo(
    () => (query.trim() ? find(reading, catalog ?? EMPTY, usage, hits, actions, Date.now(), lastCourse(), { ...where, kind: scope.kind }) : null),
    [query, reading, catalog, usage, hits, actions, where, scope.kind],
  );
  const lately = useMemo(() => (catalog ? recent(catalog, usage) : []), [catalog, usage]);
  const due = useMemo(() => {
    const opened = new Set(lately.map((f) => f.key)); // (once: in 最近打开)
    return catalog ? dueSoon(catalog).filter((f) => !opened.has(f.key)) : [];
  }, [catalog, lately]);
  const listed = useMemo(() => {
    const all = results ? [...(results.top ? [results.top] : []), ...results.groups.flatMap((g) => g.items)] : [...lately, ...due];
    return new Map(all.map((f) => [f.key, f]));
  }, [results, lately, due]);
  const first = results ? results.top?.key ?? results.groups[0]?.items[0]?.key ?? "" : lately[0]?.key ?? due[0]?.key ?? "";
  const nothing = !!results && !results.top && !results.groups.length;
  return { reading, results, lately, due, listed, first, nothing, error, loading };
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

/** ⌘↵ and ⌘⇧↵ on the chosen one; Tab finishes a course's name (`complete`). */
export function moreKeys(e: React.KeyboardEvent, chosen: () => Found | undefined, open: (f: Found | undefined, how: How) => void,
  complete?: () => string | null, setQuery?: (q: string) => void): boolean {
  if (e.key === "Tab" && !e.shiftKey && complete && setQuery) {
    const done = complete();
    if (done === null) return false;
    e.preventDefault();
    setQuery(done);
    return true;
  }
  if (e.key !== "Enter" || !(isMac ? e.metaKey : e.ctrlKey)) return false;
  e.preventDefault();
  open(chosen(), e.shiftKey ? "canvas" : "reveal");
  return true;
}

/** The query with its last word finished as the name of the course `f` is (if it's one, and the
 * word is on its way to it): "neur" ⇥ "neu100a ", which then narrows search to that course. */
export function completion(reading: Reading, f: Found | undefined): string | null {
  const last = reading.parts.at(-1);
  if (!f || f.type !== "thing" || f.entry.type !== "course" || !last || /\s$/.test(reading.query)) return null;
  if (last.role !== "word" && last.role !== "series") return null;
  // What's typed finished, else what the app calls the course ("neu100a"), else its shortest code.
  const keys = f.entry.keys ?? [];
  const typed = key(last.text);
  const own = key(f.entry.name ?? "");
  const word = keys.find((k) => k.startsWith(typed) && k !== typed)
    ?? (keys.includes(own) && own.length <= 10 ? own : undefined)
    ?? keys.filter((k) => /^\p{L}/u.test(k) && /\d/.test(k)).sort((a, b) => a.length - b.length)[0]
    ?? keys[0];
  if (!word) return null;
  const [start, end] = last.spans[0];
  return `${reading.query.slice(0, start)}${word} ${reading.query.slice(end)}`.replace(/\s+$/, " ");
}

/** The main window's 搜索 page: `input` above (with how it reads below it), what it finds below. */
export function FoundSearch({ input, query, onQuery, catalog, vocab, usage, names, courses, actions, onOpen, props, welcome }: {
  input: React.ReactNode;
  query: string;
  onQuery: (q: string) => void;
  catalog: Catalog | null;
  vocab: Vocabulary;
  usage: Usage;
  names: Map<number, string>;
  courses: Course[];
  actions: Action[];
  onOpen: (f: Found | undefined, how: How) => void;
  props?: (f: Found) => object;
  welcome: React.ReactNode; // with nothing typed and nothing to show
}) {
  const { reading, results, lately, due, listed, first, nothing, loading } = useFinding(query, catalog, vocab, usage, actions);
  const { value, choose, list } = useChosen(query, listed, first);
  return (
    <Command shouldFilter={false} loop value={value} onValueChange={choose} className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => moreKeys(e, () => listed.get(value), onOpen, () => completion(reading, listed.get(value)), onQuery)}>
      <div className="border-b border-line px-6 py-3">
        {input}
        <ReadingBar reading={reading} names={names} courses={courses} onQuery={onQuery} className="mt-2" />
      </div>
      <Command.List ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {query.trim() && nothing && !loading && <Command.Empty className="px-2 py-10 text-center text-sm text-muted">{t("没有结果")}</Command.Empty>}
        {!query.trim() && !lately.length && !due.length && welcome}
        <FoundList results={results} recent={lately} due={due} courses={courses} names={names} onOpen={(f) => onOpen(f, "open")} props={props} />
      </Command.List>
    </Command>
  );
}

/** What the search box finds where it is (a course, a folder: `scope`): as on 搜索, under the box,
 * which stays in the header (`box`: its keys move through the list and open what's chosen). */
export function FoundHere({ box, query, onQuery, scope, finder, actions, onOpen, props, note }: {
  box: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  scope: Scope;
  finder: Finder;
  actions: Action[];
  onOpen: (f: Found | undefined, how: How) => void;
  props?: (f: Found) => object;
  note?: React.ReactNode; // where it searched, and the way to search more (or less) widely
}) {
  const { catalog, vocab, usage, names, courses } = finder;
  const { reading, results, listed, first, nothing, error, loading } = useFinding(query, catalog, vocab, usage, actions, scope);
  const { value, choose, list } = useChosen(query, listed, first);
  const root = useRef<HTMLDivElement>(null);
  // In a course, its things needn't each say so.
  const others = useMemo(() => {
    const here = scope.courses?.length === 1 ? scope.courses[0] : null;
    return here === null ? names : new Map([...names].filter(([id]) => id !== here));
  }, [names, scope]);
  // The box is outside the list: what its keys do here, they do in the list (cmdk's, and ours).
  useEffect(() => {
    const input = box.current;
    if (!input) return;
    const pass = (e: KeyboardEvent) => {
      if (e.isComposing || !["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) return;
      const copy = new KeyboardEvent("keydown", { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true });
      root.current?.dispatchEvent(copy);
      if (copy.defaultPrevented || e.key !== "Tab") e.preventDefault();
    };
    input.addEventListener("keydown", pass);
    return () => input.removeEventListener("keydown", pass);
  }, [box]);
  return (
    <Command ref={root} shouldFilter={false} loop value={value} onValueChange={choose} className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => moreKeys(e, () => listed.get(value), onOpen, () => completion(reading, listed.get(value)), onQuery)}>
      <Command.List ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {(note || reading.parts.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2 pt-1 pb-1 text-xs text-muted">
            {note}
            <ReadingBar reading={reading} names={names} courses={courses} onQuery={onQuery} />
          </div>
        )}
        {error && <p className="px-2 py-6 text-sm whitespace-pre-wrap text-danger">{error}</p>}
        {query.trim() && nothing && !loading && <Command.Empty className="px-2 py-10 text-center text-sm text-muted">{t("没有结果")}</Command.Empty>}
        <FoundList results={results} recent={[]} due={[]} courses={courses} names={others} onOpen={(f) => onOpen(f, "open")} props={props} />
      </Command.List>
    </Command>
  );
}

/** What search knows (useCatalog), and the courses: for what narrows lists in the main window. */
export interface Finder {
  catalog: Catalog | null;
  vocab: Vocabulary;
  usage: Usage;
  names: Map<number, string>;
  courses: Course[];
}
export const FinderContext = createContext<Finder | null>(null);

const listed: Describe = (e) => ({ names: [e.title || e.name || ""], aliases: e.aliases, kind: [] });

/** A list narrowed by what's typed in the search box, read and matched as search does (find.ts:
 * `narrow`): `entries`, the list's things as catalog entries; `index`, where the index has more of
 * them (the text inside). `scores`: how well each matches, by key; null when nothing typed narrows
 * it (nothing, or only a course: the list is of one). */
export function useNarrowing(query: string, entries: CatalogEntry[] | null, index?: { course: number; kind: api.Kind }) {
  const finder = useContext(FinderContext);
  const vocab = finder?.vocab ?? NO_VOCABULARY;
  const abbr = finder?.catalog?.abbreviations ?? NO_ABBREVIATIONS;
  const typed = useMemo(() => read(query, vocab), [query, vocab]);
  const asked = useMemo(() => {
    const q = index && indexQuery({ ...typed, parts: typed.parts.filter((p) => p.role !== "course") }, abbr);
    return q ? { ...q, courses: [index.course], kinds: [index.kind] } : null;
  }, [typed, abbr, index?.course, index?.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const { answer, loading } = useAnswer(asked ? JSON.stringify(asked) : "", () =>
    asked ? api.find(asked.q, { ...asked, limit: 200 }) : Promise.resolve(NO_ANSWER), NO_ANSWER);
  const reading = useMemo(() => corrected(typed, answer.corrected), [typed, answer]);
  const scores = useMemo(() => {
    if (!entries || !reading.parts.some((p) => p.role !== "course")) return null;
    return narrow(reading, entries, listed, abbr, answer.hits);
  }, [reading, entries, abbr, answer]);
  return { reading, scores, loading: loading && !!asked, names: finder?.names ?? NO_NAMES, courses: finder?.courses ?? [] };
}
const NO_ABBREVIATIONS: Record<string, string[]> = {};
const NO_NAMES = new Map<number, string>();

// -- how a query reads ----------------------------------------------------------------------------

const STATUS_LABEL = { todo: t("未提交"), missing: t("缺交"), overdue: t("逾期未交"), submitted: t("已提交"), graded: t("已评分") };
const KIND_LABEL: Record<KindId, string> = {
  course: t("课程"), announcement: t("公告"), assignment: t("作业"), page: t("页面"), post: t("帖子"), module: t("模块"), tool: t("外部工具"),
  link: t("链接"), note: t("备忘录"), search: t("智能文件夹"), file: t("文件"), folder: t("文件夹"),
};
const KIND_THING: Record<KindId, Thing> = {
  course: { type: "course", course: -1 }, announcement: { type: "view", course: -1, view: "announcements" },
  assignment: { type: "view", course: -1, view: "assignments" }, page: { type: "view", course: -1, view: "pages" },
  post: { type: "view", course: -1, view: "discussion" },
  module: { type: "module", course: -1, module: -1 }, tool: { type: "tool", course: -1, tool: -1 }, link: { type: "link", url: "" },
  note: { type: "note", course: -1, id: "" }, search: { type: "search", query: "", courses: [], kinds: [], content: false },
  file: { type: "view", course: -1, view: "files" }, folder: { type: "folder", path: "" },
};

/** When, in a few words: 今天, 本周, 10月, 截止 · 本周. */
function whenLabel(p: PartOf<"when">): string {
  const l = p.when.label;
  if ("later" in l) return p.when.due ? t("还没到截止时间") : t("从现在起");
  const said =
    "day" in l ? shortDate(new Date(l.day).toISOString(), false)
    : "week" in l ? [t("上周"), t("本周"), t("下周")][l.week + 1] ?? ""
    : "month" in l ? [t("上个月"), t("本月"), t("下个月")][l.month + 1] ?? ""
    : "monthOf" in l ? new Date(l.monthOf).toLocaleDateString(locale, { month: "long" })
    : "weekend" in l ? t("周末")
    : "soon" in l ? t("未来 7 天")
    : t("最近 14 天");
  return p.when.due ? `${t("截止")} · ${said}` : said;
}

/** What a part was read as, in a few words. */
function partLabel(p: Part, names: Map<number, string>): string {
  switch (p.role) {
    case "course": {
      const all = p.courses.map((c) => names.get(c) ?? `#${c}`);
      return !all.length ? t("没有这门课") : all.length <= 2 ? all.join(" / ") : `${all[0]} +${all.length - 1}`;
    }
    case "kind": return KIND_LABEL[p.kind];
    case "when": return whenLabel(p);
    case "status": return STATUS_LABEL[p.status];
    case "source": return "Ed"; // (a name)
    default: return p.text;
  }
}

/** How what's typed was read: a chip for each part that narrows it down (a course, a kind, a time,
 * where you are with it). Clicking one takes what was typed as text instead; × takes it back.
 * Then the words taken for others (misspelled), each with a way to search for it as typed. */
export function ReadingBar({ reading, names, courses, onQuery, className = "" }: {
  reading: Reading;
  names: Map<number, string>;
  courses: Course[];
  onQuery: (q: string) => void;
  className?: string;
}) {
  const shown = reading.parts.filter((p) => p.role === "course" || p.role === "kind" || p.role === "when" || p.role === "status" || p.role === "source");
  const fixed = reading.parts.filter((p): p is PartOf<"word" | "series"> => (p.role === "word" || p.role === "series") && !!p.was);
  if (!shown.length && !fixed.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-xs ${className}`} data-no-drag>
      {shown.map((p) => (
        <span key={`${p.role}:${p.spans[0][0]}`} className="inline-flex max-w-64 items-center rounded-md bg-chip text-fg-soft">
          <button
            title={t("按文字搜索“{text}”", { text: p.text })}
            onMouseDown={(e) => e.preventDefault()} // (the input keeps the focus)
            onClick={() => onQuery(asText(reading.query, p))}
            className="flex min-w-0 items-center gap-1 rounded-l-md py-0.5 pr-1 pl-1.5 hover:bg-line"
          >
            <PartIcon part={p} courses={courses} />
            <span className="truncate">{partLabel(p, names)}</span>
          </button>
          <button
            aria-label={t("去掉")}
            title={t("去掉")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onQuery(without(reading.query, p))}
            className="rounded-r-md p-1 text-muted hover:bg-line hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {fixed.map((p) => (
        <span key={`fix:${p.spans[0][0]}`} className="text-muted">
          {tx("按 {word} 搜索", { word: <span className="font-medium text-fg-soft">{p.text}</span> })}
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => onQuery(asText(reading.query, p))} className="ml-1.5 text-accent hover:underline">
            {t("仍搜索“{word}”", { word: p.was! })}
          </button>
        </span>
      ))}
    </div>
  );
}

function PartIcon({ part, courses }: { part: Part; courses: Course[] }) {
  const icon = "size-3.5 shrink-0 text-muted";
  if (part.role === "course") {
    return part.courses.length === 1
      ? <span className="[&_svg]:size-3.5 [&>*]:shrink-0"><ThingIcon thing={{ type: "course", course: part.courses[0] }} courses={courses} className={icon} /></span>
      : <ThingIcon thing={{ type: "course", course: -1 }} className={icon} />;
  }
  if (part.role === "kind") return <ThingIcon thing={KIND_THING[part.kind]} className={icon} />;
  if (part.role === "when") return <CalendarDays className={icon} aria-hidden />;
  if (part.role === "source") return <MessagesSquare className={icon} aria-hidden />;
  return <CircleCheck className={icon} aria-hidden />;
}

// -- what's found -----------------------------------------------------------------------------------

const ACTION_ICON = { sync: RefreshCw, settings: SettingsIcon, "smart-folder": Sparkles, main: AppWindow };

const GROUP: Record<GroupId, string> = {
  courses: t("课程@@group"), places: t("页面与工具"), assignments: t("作业"), announcements: t("公告"), files: t("文件与文件夹"),
  actions: t("操作"), inside: t("正文中提到"), related: t("意思相近"),
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
            <SourceTag source={e.source} />
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
