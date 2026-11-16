// What search finds (lib/find.ts), shown the Spotlight way: the best of all on top, then groups
// (courses, pages and tools, assignments, announcements, files and folders, things to do, what's
// only inside), a few of each until asked for all; before anything is typed, what you opened
// lately and what's due soon. Above it, how what's typed was read (lib/query.ts): a chip for each
// part that narrows it down. Shared by the search window and the main window's search
// box (in a course, in a folder: `Scope`), inside a cmdk <Command> (arrows move, enter
// opens). And the same, narrowing a list (a course's tab) as you type: `useNarrowing`.
import { Command } from "cmdk";
import { AppWindow, CalendarDays, CircleCheck, MessagesSquare, RefreshCw, Settings as SettingsIcon, Sparkles, X } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type { CatalogEntry, Course, Usage } from "../lib/api";
import { shortDate, untilDue } from "../lib/dates";
import { type Action, type Catalog, type Describe, type Found, type GroupId, type NameWord, type Results, type Scope, dueSoon, find, likelyWord, nameWords, narrow, prepare, recent, vocabulary } from "../lib/find";
import { locale, t, tn, tx } from "../lib/i18n";
import { zh } from "../lib/zh";
import { isMac } from "../lib/keys";
import { KINDS } from "../lib/kinds";
import { type KindId, NO_VOCABULARY, type Part, type PartOf, type Reading, type Vocabulary, asText, corrected, indexQuery, key, read, shortCode, singular } from "../lib/query";
import { type Thing, type ViewName, setFolderTitles, titlesAlong } from "../lib/things";
import { useLoaded } from "../lib/useLoaded";
import { useAnswer } from "../lib/useSearch";
import { KIND, ResultBody, Snippet, baseName, formatDate } from "./Result";
import { SourceTag, ThingIcon, thingName, useThing } from "./Things";
import { Thumb } from "./Thumb";

/** One of the app's words as it's said in each language (zh.ts has the Chinese). */
function inBoth(en: string): string[] {
  const z = zh[en];
  return [en.split("@@")[0], ...(z === undefined ? [] : [z])];
}

// What else a course's views answer to: their names as tabs and as cards, in both languages
// (and a few Chinese words of no English of their own).
const VIEW_WORDS: Record<ViewName, string[]> = {
  overview: ["Overview"],
  modules: ["Modules", "This week's module"],
  announcements: ["Announcements", "Latest announcements"],
  ed: ["Discussion", "讨论区", "Post"], // i18n-ignore
  assignments: ["Assignments", "Coming up"],
  grades: ["Grades"],
  files: ["Files", "Recently added files"],
  syllabus: ["Syllabus", "Syllabus@@full"],
  pages: ["Pages"],
  tools: ["Tools and links"],
  canvas: ["Open in Canvas"],
};
// What kind of thing it is, in both languages: "cs70 公告" finds CS 70's announcements by name.
const KIND_WORDS: Record<string, string> = {
  course: "Course",
  announcement: "Announcements",
  assignment: "Assignments",
  page: "Page",
  post: "Post",
  module: "Module",
  tool: "External tool",
  link: "Links",
  note: "Notes",
  search: "Smart folder",
  file: "File",
  folder: "Folder",
};
// The words a query says a kind of thing by (both languages, as the app says them; one word each).
const KIND_SAID: Record<KindId, string[]> = {
  course: ["Course"], announcement: ["Announcements"], assignment: ["Assignments"], page: ["Pages", "Page"], post: ["Post", "Discussion", "thread"], module: ["Modules", "Module"],
  tool: ["External tool", "工具"], link: ["Links"], note: ["Notes"], search: ["Smart folder"], file: ["Files", "File"], folder: ["Folder"], // i18n-ignore
};
const KIND_OF_WORD: Record<string, KindId> = Object.fromEntries(
  (Object.entries(KIND_SAID) as [KindId, string[]][]).flatMap(([kind, said]) =>
    [...said.flatMap(inBoth), kind].map((w) => w.toLowerCase()).filter((w) => !w.includes(" ")).map((w) => [singular(w), kind])),
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

const NOTHING: Usage = { opened: {}, picks: [] };

/** The catalog, made ready for finding, what reading a query knows of it, and what you open;
 * loaded again when `again` changes or "catalog" is reloaded (and only while `on`: what was loaded
 * last stays). */
export function useCatalog(again: unknown[], courses: Course[] = [], on = true) {
  const data = useLoaded(on ? "catalog" : null, api.catalog, { again, follow: true }).value;
  const catalog = useMemo(() => {
    if (!data) return null;
    setFolderTitles(data.folder_titles); // (what comes next is named and found by them)
    return prepare(data.things, describeEntry(courses), data.abbreviations);
  }, [data, courses]);
  const vocab = useMemo(() => (catalog ? vocabulary(catalog, KIND_OF_WORD) : NO_VOCABULARY), [catalog]);
  const names = useMemo(
    () => new Map((data?.things ?? []).flatMap((e) => (e.type === "course" ? [[e.course, e.name ?? ""] as const] : []))),
    [data],
  );
  return { catalog, vocab, usage: data ?? NOTHING, names };
}

/** Things to do from search: sync everything or one course, settings, a new smart folder. */
export function actionsFor(names: Map<number, string>, extra: Action[] = []): Action[] {
  return [
    { id: "sync", label: t("Sync all courses"), names: [t("Sync all courses"), ...inBoth("Sync")] },
    ...[...names].map(([course, name]) => ({ id: `sync:${course}`, label: t("Sync {name}", { name }), names: inBoth("Sync"), course })),
    { id: "settings", label: t("Open Settings"), names: [t("Open Settings"), ...inBoth("Settings")] },
    { id: "smart-folder", label: t("New smart folder…"), names: inBoth("New smart folder…") },
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
const ALL_FILES: Scope = { under: "" };

/** What's found for `query`, as you type: how it reads, what that finds by name and in the index
 * (or, with nothing typed, what you opened lately and what's due soon), each by key, and which
 * comes first. `scope`: where it's searched from (a course; a folder; "": any folder), unless what's
 * typed names a course. */
export function useFinding(query: string, catalog: Catalog | null, vocab: Vocabulary, usage: Usage, actions: Action[], scope: Scope = NOWHERE) {
  const typed = useMemo(() => read(query, vocab), [query, vocab]);
  // (Naming a course leaves a folder; from All files, it's that course's files.)
  const where = typed.parts.some((p) => p.role === "course") ? (scope.under === "" ? ALL_FILES : NOWHERE) : scope;
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
    () => (query.trim() ? find(reading, catalog ?? EMPTY, usage, hits, actions, Date.now(), lastCourse(), { ...where, kind: scope.kind, source: scope.source }) : null),
    [query, reading, catalog, usage, hits, actions, where, scope.kind, scope.source],
  );
  const lately = useMemo(() => (catalog ? recent(catalog, usage) : []), [catalog, usage]);
  const due = useMemo(() => {
    const opened = new Set(lately.map((f) => f.key)); // (once: in Recently opened)
    return catalog ? dueSoon(catalog).filter((f) => !opened.has(f.key)) : [];
  }, [catalog, lately]);
  const listed = useMemo(() => {
    const all = results ? [...(results.top ? [results.top] : []), ...results.groups.flatMap((g) => g.items)] : [...lately, ...due];
    return new Map(all.map((f) => [f.key, f]));
  }, [results, lately, due]);
  const first = results ? results.top?.key ?? results.groups[0]?.items[0]?.key ?? "" : lately[0]?.key ?? due[0]?.key ?? "";
  const nothing = !!results && !results.top && !results.groups.length;
  const words = useMemo(() => (catalog ? nameWords(catalog, usage, vocab.kinds) : undefined), [catalog, usage, vocab]); // (for completing)
  return { reading, results, lately, due, listed, first, nothing, error, loading, words };
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

/** ⌘↵ and ⌘⇧↵ on the chosen one; Tab finishes a course's name (`complete`), or, with nothing to
 * complete, asks for the likeliest word (`ask`: the next Tab takes it). It stays in the box. */
export function moreKeys(e: React.KeyboardEvent, chosen: () => Found | undefined, open: (f: Found | undefined, how: How) => void,
  complete?: () => string | null, setQuery?: (q: string) => void, ask?: () => void): boolean {
  if (e.nativeEvent.isComposing) return false; // (the input method's: choosing a word)
  if (e.key === "Tab" && !e.shiftKey && complete && setQuery) {
    const done = complete();
    e.preventDefault();
    if (done === null) ask?.();
    else setQuery(done);
    return true;
  }
  if (e.key !== "Enter" || !(isMac ? e.metaKey : e.ctrlKey)) return false;
  e.preventDefault();
  open(chosen(), e.shiftKey ? "canvas" : "reveal");
  return true;
}

/** The query finished as a course's name: the chosen result's, if it's a course, else the first
 * course found whose name what's typed starts (a file named with the course's code may come
 * first). What's typed goes on as typed ("neu 1" ⇥ "neu 100a "), over the last few words; when
 * it's something else ("multivar"), its last word becomes the name ("m53 "). Either narrows search
 * to that course. Else, the word being typed finished as the word of names it most likely is
 * (`words`: "ann" ⇥ "announcements ", "cs70 ass" ⇥ "cs70 assignments ", "midterm r" ⇥ "midterm
 * review "), if that's clear (`unsure`: or not). */
export function completion(reading: Reading, f: Found | undefined, found: Iterable<Found> = [], words?: Map<string, NameWord>,
  unsure = false): string | null {
  const { query, parts } = reading;
  const last = parts.at(-1);
  if (!last || /\s$/.test(query) || (last.role !== "word" && last.role !== "series")) return null;
  const end = last.spans[0][1];
  // What may be the start of a name, longest first: the last words, up to three, typed together.
  const starts: { at: number; typed: string }[] = [];
  for (let i = parts.length - 1; i >= 0 && i >= parts.length - 3; i--) {
    const p = parts[i];
    if (p.role !== "word" && p.role !== "series") break;
    if (i < parts.length - 1 && query.slice(p.spans[0][1], parts[i + 1].spans[0][0]).trim()) break;
    starts.unshift({ at: p.spans[0][0], typed: key(query.slice(p.spans[0][0], end)) });
  }
  const courseOf = (x: Found | undefined) => {
    if (!x || x.type !== "thing" || x.entry.type !== "course") return null;
    const id = x.entry.course;
    return parts.some((p) => p.role === "course" && p.courses.includes(id)) ? null : x.entry; // (it says so already)
  };
  // The course's word that goes on from what's typed: what the app calls it, if that's short; else
  // the shortest with its number ("phys" ⇥ "phys7b", not "physics7blec001speliotopoulos").
  const goingOn = (c: CatalogEntry) => {
    const keys = c.keys ?? [];
    const own = key(c.name ?? "");
    const order = [...(own.length <= 10 ? [own] : []), ...keys.filter((k) => /\d/.test(k)).sort((a, b) => a.length - b.length),
      ...[...keys].sort((a, b) => a.length - b.length)];
    for (const { typed } of starts) {
      const k = order.find((k) => keys.includes(k) && k.startsWith(typed) && k !== typed);
      if (k) return { typed, k };
    }
    return null;
  };
  const tail = (s: string) => `${s} ${query.slice(end)}`.replace(/\s+$/, " ");
  const chosen = courseOf(f);
  const c = chosen ?? [...found].map(courseOf).find((e) => e && goingOn(e));
  if (!c) {
    if (!words || last.role !== "word" || last.quoted) return null;
    const courses = parts.flatMap((p) => (p.role === "course" ? p.courses : []));
    const kind = parts.find((p): p is PartOf<"kind"> => p.role === "kind")?.kind ?? null;
    const typed = query.slice(last.spans[0][0], end);
    const others = parts.slice(0, -1).flatMap((p) =>
      p.role === "word" && !p.quoted ? [p.text.toLowerCase()] : p.role === "series" ? p.name.split(" ") : []);
    const w = likelyWord(typed, words, courses, kind, others, unsure);
    return w ? tail(query.slice(0, end) + w.slice(typed.length)) : null;
  }
  const on = goingOn(c);
  if (on) return tail(query.slice(0, end) + on.k.slice(on.typed.length));
  // Something else typed: its last word becomes what the app calls the course, else its shortest code.
  const keys = c.keys ?? [];
  const own = key(c.name ?? "");
  const word = (keys.includes(own) && own.length <= 10 ? own : undefined)
    ?? shortCode(keys)
    ?? keys[0];
  return word ? tail(query.slice(0, last.spans[0][0]) + word) : null;
}

/** What ⇥ would make of the query, faint in the box, and the key: the rest of the name after
 * what's typed, or "→ m53" when it changes what's typed. Over the input (in a `relative` box), in its type. */
export function CompletionGhost({ query, completion, className }: { query: string; completion: string | null; className: string }) {
  if (!completion) return null;
  const done = completion.trimEnd();
  const rest = done.toLowerCase().startsWith(query.toLowerCase()) ? done.slice(query.length) : `  → ${done}`;
  if (!rest) return null;
  return (
    <span aria-hidden className={`pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre ${className}`}>
      <span className="invisible">{query}</span>
      <span className="text-muted/70">{rest}</span>
      <TabKey className="ml-2" />
    </span>
  );
}

/** Whether ⇥ asked for the likeliest word (`completion`'s `unsure`), for the query as it is. */
export function useAsked(query: string): [boolean, () => void] {
  const [asked, setAsked] = useState<string | null>(null);
  return [asked === query, () => setAsked(query)];
}

/** The key that completes it, after what it would add. */
export function TabKey({ className = "" }: { className?: string }) {
  return (
    <kbd title={t("Press Tab to complete")} className={`shrink-0 rounded border border-line px-1 font-sans text-[10px] leading-4 text-muted ${className}`}>
      {isMac ? "⇥ tab" : "Tab"}
    </kbd>
  );
}

/** What the search box finds where it is (a course, a folder: `scope`): as in the search window, under the box,
 * which stays in the header (`box`: its keys move through the list and open what's chosen). */
export function FoundHere({ box, query, onQuery, scope, finder, actions, onOpen, props, note, onCompletion, hover = false }: {
  box: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  scope: Scope;
  finder: Finder;
  actions: Action[];
  onOpen: (f: Found | undefined, how: How, reading: Reading) => void; // (what's marked there: the words as they were read)
  props?: (f: Found) => object;
  note?: React.ReactNode; // where it searched, and the way to search more (or less) widely
  onCompletion?: (completion: string | null) => void; // what ⇥ would make of the query (for the box to show)
  hover?: boolean; // the pointer only shows where it is; what's chosen is the keys'
}) {
  const { catalog, vocab, usage, names, courses } = finder;
  const { reading, results, listed, first, nothing, error, loading, words } = useFinding(query, catalog, vocab, usage, actions, scope);
  const { value, choose, list } = useChosen(query, listed, first);
  const root = useRef<HTMLDivElement>(null);
  const [asked, ask] = useAsked(query);
  const done = completion(reading, listed.get(value), listed.values(), words, asked);
  // Before the paint: else the box shows the last query's completion for a frame (after ⇥, "→ double").
  useLayoutEffect(() => onCompletion?.(done), [done]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => onCompletion?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
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
      if (e.isComposing || !["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key) || (e.key === "Tab" && e.ctrlKey)) return; // (⌃⇥: the next tab)
      const copy = new KeyboardEvent("keydown", { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true });
      root.current?.dispatchEvent(copy);
      if (copy.defaultPrevented || e.key !== "Tab") e.preventDefault();
    };
    input.addEventListener("keydown", pass);
    return () => input.removeEventListener("keydown", pass);
  }, [box]);
  return (
    <Command ref={root} shouldFilter={false} loop value={value} onValueChange={choose} disablePointerSelection={hover}
      className={`flex min-h-0 flex-1 flex-col ${hover ? "[&_[cmdk-item]:hover]:bg-chip" : ""}`}
      onKeyDown={(e) => moreKeys(e, () => listed.get(value), (f, how) => onOpen(f, how, reading), () => done, onQuery, ask)}>
      <Command.List ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {(note || reading.parts.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2 pt-1 pb-1 text-xs text-muted">
            {note}
            <ReadingBar reading={reading} names={names} courses={courses} onQuery={onQuery} />
          </div>
        )}
        {error && <p className="px-2 py-6 text-sm whitespace-pre-wrap text-danger">{error}</p>}
        {query.trim() && nothing && !loading && <Command.Empty className="px-2 py-10 text-center text-sm text-muted">{t("No results")}</Command.Empty>}
        <FoundList results={results} recent={[]} due={[]} courses={courses} names={others} onOpen={(f) => onOpen(f, "open", reading)} props={props} />
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
 * them (the text inside): a kind of thing in a course, or what's from a source. `scores`: how well each matches, by key; null when nothing typed narrows
 * it (nothing, or only a course: the list is of one). */
export function useNarrowing(query: string, entries: CatalogEntry[] | null, index?: { course: number; kind?: api.Kind; source?: "ed" }) {
  const finder = useContext(FinderContext);
  const vocab = finder?.vocab ?? NO_VOCABULARY;
  const abbr = finder?.catalog?.abbreviations ?? NO_ABBREVIATIONS;
  const typed = useMemo(() => read(query, vocab), [query, vocab]);
  const asked = useMemo(() => {
    const q = index && indexQuery({ ...typed, parts: typed.parts.filter((p) => p.role !== "course") }, abbr);
    return q ? { ...q, courses: [index.course], ...(index.kind ? { kinds: [index.kind] } : { source: index.source }) } : null;
  }, [typed, abbr, index?.course, index?.kind, index?.source]); // eslint-disable-line react-hooks/exhaustive-deps
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

const STATUS_LABEL = { todo: t("Not submitted"), missing: t("Missing"), overdue: t("Overdue"), submitted: t("Submitted"), graded: t("Graded") };
const KIND_THING: Record<KindId, Thing> = {
  course: { type: "course", course: -1 }, announcement: { type: "view", course: -1, view: "announcements" },
  assignment: { type: "view", course: -1, view: "assignments" }, page: { type: "view", course: -1, view: "pages" },
  post: { type: "view", course: -1, view: "ed" },
  module: { type: "module", course: -1, module: -1 }, tool: { type: "tool", course: -1, tool: -1 }, link: { type: "link", url: "" },
  note: { type: "note", course: -1, id: "" }, search: { type: "search", query: "", courses: [], kinds: [], content: false },
  file: { type: "view", course: -1, view: "files" }, folder: { type: "folder", path: "" },
};

/** When, in a few words: Today, This week, October, Due · This week. */
function whenLabel(p: PartOf<"when">): string {
  const l = p.when.label;
  if ("later" in l) return p.when.due ? t("Not due yet") : t("From now on");
  const said =
    "day" in l ? shortDate(new Date(l.day).toISOString(), false)
    : "week" in l ? [t("Last week"), t("This week"), t("Next week")][l.week + 1] ?? ""
    : "month" in l ? [t("Last month"), t("This month"), t("Next month")][l.month + 1] ?? ""
    : "monthOf" in l ? new Date(l.monthOf).toLocaleDateString(locale, { month: "long" })
    : "weekend" in l ? t("This weekend")
    : "soon" in l ? t("Next 7 days")
    : t("Last 14 days");
  return p.when.due ? `${t("Due")} · ${said}` : said;
}

/** What a part was read as, in a few words. */
function partLabel(p: Part, names: Map<number, string>): string {
  switch (p.role) {
    case "course": {
      const all = p.courses.map((c) => names.get(c) ?? `#${c}`);
      return !all.length ? t("No such course") : all.length <= 2 ? all.join(" / ") : `${all[0]} +${all.length - 1}`;
    }
    case "kind": return KINDS[p.kind].all;
    case "when": return whenLabel(p);
    case "status": return STATUS_LABEL[p.status];
    case "source": return "Ed"; // (a name)
    default: return p.text;
  }
}

/** How what's typed was read: a chip for each part that narrows it down (a course, a kind, a time,
 * where you are with it). Its × takes what was typed as text instead: the word stays, to match.
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
    <div className={`flex flex-wrap items-center gap-1.5 text-xs ${className}`} data-no-drag data-no-mark>
      {shown.map((p) => (
        <span key={`${p.role}:${p.spans[0][0]}`} className="inline-flex max-w-64 items-center rounded-md bg-chip text-fg-soft">
          <span className="flex min-w-0 items-center gap-1 py-0.5 pr-1 pl-1.5">
            <PartIcon part={p} courses={courses} />
            <span className="truncate">{partLabel(p, names)}</span>
          </span>
          <button
            aria-label={t("Search for “{text}” as text", { text: p.text })}
            title={t("Search for “{text}” as text", { text: p.text })}
            onMouseDown={(e) => e.preventDefault()} // (the input keeps the focus)
            onClick={() => onQuery(asText(reading.query, p))}
            className="rounded-r-md p-1 text-muted hover:bg-line hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {fixed.map((p) => (
        <span key={`fix:${p.spans[0][0]}`} className="text-muted">
          {tx("Showing results for {word}.", { word: <span className="font-medium text-fg-soft">{p.text}</span> })}
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => onQuery(asText(reading.query, p))} className="ml-1.5 text-accent hover:underline">
            {t("Search for “{word}” instead", { word: p.was! })}
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
  courses: t("Courses"), places: t("Pages and tools"), assignments: t("Assignments"), announcements: t("Announcements"), files: t("Files and folders"),
  actions: t("Actions"), inside: t("Mentioned in the text"), related: t("Similar in meaning"),
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
        {recent.length > 0 && <Command.Group heading={t("Recently opened")} className={heading}>{recent.map((f) => item(f))}</Command.Group>}
        {due.length > 0 && <Command.Group heading={t("Coming up")} className={heading}>{due.map((f) => item(f))}</Command.Group>}
      </>
    );
  }
  return (
    <>
      {results.top && <Command.Group heading={t("Top hit")} className={heading}>{item(results.top, true)}</Command.Group>}
      {results.groups.map((g) => {
        const shown = all.has(g.id) ? g.items.slice(0, MOST) : g.items.slice(0, g.cap);
        const more = g.items.length - shown.length;
        return (
          <Command.Group key={g.id} heading={GROUP[g.id]} className={heading}>
            {shown.map((f) => item(f))}
            {more > 0 && !all.has(g.id) && (
              <Command.Item value={`more:${g.id}`} onSelect={() => setAll((s) => new Set(s).add(g.id))}
                className={`${itemClass} py-1.5 text-xs text-muted`}>
                {tn("1 more ›", "{n} more ›", { n: more })}
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
      {e.type === "file" ? (
        <div className="shrink-0"><Thumb path={e.path} name={baseName(e.path)} mtime={null} size={top ? 40 : 32} iconClass={top ? "size-5" : "size-4"} /></div>
      ) : (
        <span className={`mt-0.5 shrink-0 text-muted ${top ? "[&_svg]:size-5" : ""}`}><ThingIcon thing={e} courses={courses} /></span>
      )}
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
    case "course": case "module": case "tool": case "search": return KINDS[e.type].one;
    case "doc": return KIND[e.kind].label; // (as search results say it: "Ed post")
    case "link": return e.url.replace(/^https?:\/\/(www\.)?/, "");
    case "note": return e.text || KINDS.note.one;
    case "file": case "folder": return titlesAlong(e.path, 2, -1).join(" / ");
    default: return "";
  }
}
