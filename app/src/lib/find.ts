// Search as you type: everything there is to go to, by name (the catalog: courses, their views,
// documents, modules, tools, files and folders, what you put in places), and what the index finds
// by the text inside. What it finds comes in groups, the best of all on top. What you open most,
// and lately, comes first; what you opened after typing the same, on top.
//
// What's typed is read first (query.ts): a course, a time, where you are with an assignment narrow
// it down; the rest is matched against names, match-sorter's way, part by part: each has to match
// what a thing is called (its own names) or what it's in (its course, its kind, its folders), and
// at least one its own names. A kind word names what's of that kind ("cs70 公告": CS 70's
// announcements); one of a series, what's numbered so in that series by any of its names ("hw3":
// Homework 3, HW03.pdf, Problem Set 3); a word, also what it's an abbreviation of ("mt": midterm).
//
// Nothing here draws or says anything (no i18n): what things are called comes from `describe`.
import { matchSorterWithRankInfo, rankings } from "match-sorter";
import type { CatalogEntry, Hit, Usage } from "./api";
import { CJK, type KindId, type Part, type PartOf, type Reading, type Status, type Vocabulary, little, seriesIn, seriesNear, singular, spaced } from "./query";
import { termRank } from "./terms";
import { thingKey, thingOfHit } from "./things";

export { spaced } from "./query";

/** Something to do (sync, settings…), found the way things are. */
export interface Action {
  id: string;
  label: string; // what it says
  names: string[]; // what it answers to, in both languages
  course?: number; // what it's about: only found when the query says the course too
}

export type Found =
  | { type: "thing"; key: string; entry: CatalogEntry; hit?: Hit; score: number }
  | { type: "hit"; key: string; hit: Hit; score: number } // only the index has it (a file not downloaded)
  | { type: "action"; key: string; action: Action; score: number };

export type GroupId = "courses" | "places" | "assignments" | "announcements" | "files" | "actions" | "inside" | "related";
export interface Group {
  id: GroupId;
  items: Found[]; // best first (all of them: `cap` is how many to show unless asked for all)
  cap: number;
}
export interface Results {
  top: Found | null;
  groups: Group[]; // the best group first; what's only inside, then what's only like it in meaning, last
}

/** What a thing is called (`names`: as it's shown; `aliases`: what else it answers to, in any
 * language), and what kind of thing it is, in words. */
export type Describe = (e: CatalogEntry) => { names: string[]; aliases: string[]; kind: string[] };

interface Prepared {
  entry: CatalogEntry;
  key: string;
  names: string[]; // each also with its parts spaced out ("HW3_sol.pdf": "HW 3 sol pdf")
  aliases: string[];
  context: string[]; // its kind, its folders
  words: string; // its names and aliases, spaced and lower-cased, a space around each word: for whole words
  starts: string[]; // its names, spaced and lower-cased: for what one starts with
  series: { name: string; n: number }[]; // what it's numbered in its names ("Homework 3": homework 3)
  kind: KindId | "view";
  course: number | null; // the course it's in (a course: itself)
  term: number; // its course's term (termRank)
}

/** The catalog, made ready for matching (once, when it's loaded). */
export interface Catalog {
  entries: Prepared[];
  byKey: Map<string, Prepared>;
  courses: Map<number, Prepared>;
  latestTerm: number;
  series: Map<string, Set<number>>; // every series in names, with the numbers there are of it
  abbreviations: Record<string, string[]>; // "mt" -> midterm... (the index's: built in, and yours)
}

const CAP: Record<GroupId, number> = { courses: 3, places: 5, assignments: 4, announcements: 4, files: 5, actions: 3, inside: 5, related: 5 };
const MOST = 50; // shown in a group asked for all
const DAY = 24 * 3600 * 1000;

const variants = (s: string) => [...new Set([s, spaced(s)].filter(Boolean))];
const kindOf = (e: CatalogEntry): Prepared["kind"] => (e.type === "doc" ? e.kind : e.type);

export function prepare(things: CatalogEntry[], describe: Describe, abbreviations: Record<string, string[]> = {}): Catalog {
  const terms = new Map<number, number>();
  for (const e of things) if (e.type === "course") terms.set(e.course, termRank(e.term ?? null));
  const series = new Map<string, Set<number>>();
  const entries = things.map((entry): Prepared => {
    const { names, aliases, kind } = describe(entry);
    const folders = entry.type === "file" || entry.type === "folder" ? entry.path.split("/").slice(-3, -1) : [];
    const own = [...new Set(names.filter(Boolean).flatMap(variants))];
    const others = [...new Set(aliases.filter(Boolean).flatMap(variants))].filter((a) => !own.includes(a));
    const numbered = [...names, ...aliases].filter(Boolean).flatMap(seriesIn);
    for (const s of numbered) series.set(s.name, (series.get(s.name) ?? new Set()).add(s.n));
    const course = entry.type === "course" ? entry.course : entry.in_course;
    return {
      entry,
      key: thingKey(entry),
      names: own,
      aliases: others,
      context: [...new Set([...kind, ...folders].filter(Boolean).flatMap(variants))],
      words: ` ${[...names, ...aliases].filter(Boolean).map((s) => spaced(s).toLowerCase()).join(" | ")} `,
      starts: names.filter(Boolean).map((s) => spaced(s).toLowerCase()),
      series: numbered,
      kind: kindOf(entry),
      course,
      term: course !== null ? terms.get(course) ?? 0 : 0,
    };
  });
  return {
    entries,
    byKey: new Map(entries.map((p) => [p.key, p])),
    courses: new Map(entries.flatMap((p) => (p.entry.type === "course" ? [[p.entry.course, p] as const] : []))),
    latestTerm: Math.max(0, ...terms.values()),
    series,
    abbreviations,
  };
}

/** What reading a query needs to know of what's there (query.ts): the courses' words, the series
 * in names; and `kinds`, the words for kinds of things (the app's, in both languages). */
export function vocabulary(catalog: Catalog, kinds: Record<string, KindId>): Vocabulary {
  const courses = [...catalog.courses.values()].map((p) => ({ id: p.course!, keys: p.entry.keys ?? [] }));
  return { courses, kinds, series: catalog.series, abbreviations: catalog.abbreviations };
}

/** The words of a query (lower-cased, as typed: "cs70 hw3"). */
export const words = (query: string) => query.toLowerCase().split(/\s+/).filter((w) => spaced(w));
const normal = (query: string) => words(query).join(" ");

/** A word's match good enough to count: it starts a word (or is a word's initials), as in
 * Spotlight: "sync" isn't "asynchronous". Chinese has no spaces between words: anywhere in it. */
function counts(rank: number, word: string): boolean {
  if (rank >= rankings.WORD_STARTS_WITH) return true;
  if (rank === rankings.CONTAINS) return CJK.test(word);
  return rank === rankings.ACRONYM && word.replace(/\s/g, "").length >= 2;
}

/** What counts how much, in one place. A part's match is match-sorter's rank (EQUAL 6 … ACRONYM
 * 2) or one of these; a thing's score, its parts' average, then what makes it likelier to be what
 * you're after. What comes first for the queries in queries.test.ts depends on these. */
const W = {
  alias: 0.25, // less for matching only what else a thing answers to, not what it's shown as
  expanded: 0.3, // less for matching what a word is an abbreviation of ("mt": midterm)
  context: 0.5, // a part matching only what a thing is in (its course, kind, folders): this much of it
  series: rankings.STARTS_WITH, // one of a series, by any of its names: as good as a name starting so
  kind: rankings.WORD_STARTS_WITH + 0.5, // of the kind a word says
  indexName: rankings.WORD_STARTS_WITH + 0.2, // what the index found by name (its first; then a little less each)
  listed: 3, // all of what a time or a status narrows down to (nearer in time, more)
  inside: 1, // what the index found only inside (its first; then a little less each)
  // What makes a thing likelier to be what you're after:
  opened: 0.5, // how much you go to it (frecency: often, and lately), up to 4 of this
  picked: 3, // what you opened after typing the same (or more), and more the more you did
  course: 0.6, // a course itself
  view: 0.2, // one of a course's views
  term: 1, // this term's
  here: 0.4, // of the course you were last in
  dueSoon: 0.3, // due within the week, and not handed in
  fresh: 0.2, // new in the last two weeks (less as it ages)
  post: 1, // a post on Ed: what's said about a thing, after the thing itself
};

/** How well `word` matches each item's values (`values`, then `others`: a little less), by item;
 * the best of the word as typed and spaced out. */
function ranks<T>(items: T[], word: string, values: (item: T) => string[], others?: (item: T) => string[]): Map<T, number> {
  const out = new Map<T, number>();
  for (const alt of variants(word)) {
    const keys = others ? [values, others] : [values];
    for (const r of matchSorterWithRankInfo(items, alt, { keys, threshold: rankings.ACRONYM, sorter: (x) => x })) {
      if (!counts(r.rank, alt)) continue;
      const rank = Math.min(r.rank, rankings.EQUAL) - (r.keyIndex > 0 ? W.alias : 0);
      out.set(r.item, Math.max(out.get(r.item) ?? 0, rank));
    }
  }
  return out;
}

/** What else a word stands for: what it's an abbreviation of, what's an abbreviation of it
 * ("midterm": mt), and itself without its plural. */
function alternatives(word: string, abbr: Record<string, string[]>): string[] {
  const out = new Set<string>([...(abbr[word] ?? [])]);
  for (const [k, v] of Object.entries(abbr)) if (!CJK.test(k) && v.includes(word)) out.add(k);
  if (singular(word) !== word) out.add(singular(word));
  out.delete(word);
  return [...out];
}

/** How well a word matches each thing's names as a whole word, by what it stands for. */
function wholeWords(entries: Prepared[], alts: string[], into: Map<Prepared, number>) {
  if (!alts.length) return;
  for (const p of entries) {
    for (const alt of alts) {
      const latin = !CJK.test(alt);
      if (!(latin ? p.words.includes(` ${alt} `) || p.words.includes(` ${alt}s `) : p.words.includes(alt))) continue;
      const first = p.starts.some((s) => s === alt || s.startsWith(alt + " "));
      const rank = (first ? rankings.STARTS_WITH : rankings.WORD_STARTS_WITH) - W.expanded;
      if (rank > (into.get(p) ?? 0)) into.set(p, rank);
    }
  }
}

/** How much you go to it: more often, and lately, more. */
function frecency(used: { count: number; last: string } | undefined, now: number): number {
  if (!used) return 0;
  const days = Math.max(0, (now - Date.parse(used.last)) / DAY);
  return Math.log2(1 + used.count) / (1 + days / 14);
}

/** What you opened after typing this (or more of it): key -> how much. */
function picked(query: string, usage: Usage, now: number): Map<string, number> {
  const out = new Map<string, number>();
  const q = normal(query);
  if (!q) return out;
  for (const p of usage.picks) {
    if (!p.query.startsWith(q)) continue;
    const days = Math.max(0, (now - Date.parse(p.last)) / DAY);
    out.set(p.key, (out.get(p.key) ?? 0) + (p.count * (p.query === q ? 2 : 1)) / (1 + days / 30));
  }
  return out;
}

const handedIn = (status: CatalogEntry["status"]) => status === "submitted" || status === "graded" || status === "excused";

/** Where you are with it, as a reading says it. */
function isStatus(e: CatalogEntry, s: Status, now: number): boolean {
  if (e.type !== "doc" || e.kind !== "assignment") return false;
  switch (s) {
    case "todo": return e.status === "unsubmitted" || e.status === "missing";
    case "missing": return e.status === "missing";
    case "overdue": return (e.status === "unsubmitted" || e.status === "missing") && !!e.due && Date.parse(e.due) < now;
    case "submitted": return e.status === "submitted" || e.status === "graded";
    case "graded": return e.status === "graded";
  }
}

/** What makes one thing likelier than another that matches as well to be what you're after. */
interface Context { catalog: Catalog; usage: Usage; picks: Map<string, number>; now: number; here: number | null }
function bonus(p: Prepared, { catalog, usage, picks, now, here }: Context): number {
  const e = p.entry;
  let b = W.opened * Math.min(frecency(usage.opened[p.key], now), 4);
  const pick = picks.get(p.key) ?? 0;
  if (pick > 0) b += W.picked + Math.min(pick, 3);
  if (e.type === "course") b += W.course;
  else if (e.type === "view") b += W.view;
  else if (e.type === "doc" && e.kind === "post") b -= W.post;
  if (p.term && p.term === catalog.latestTerm) b += W.term; // (what was last term's is seldom what you're after)
  if (here !== null && p.course === here) b += W.here;
  const due = e.due ? Date.parse(e.due) - now : NaN;
  if (due > 0 && due < 7 * DAY && !handedIn(e.status)) b += W.dueSoon;
  const age = e.date ? (now - Date.parse(e.date)) / DAY : NaN;
  if (age >= 0 && age < 14) b += W.fresh * (1 - age / 14);
  return b;
}

function groupOf(f: Found): GroupId {
  if (f.type === "action") return "actions";
  if (f.type === "hit") {
    const k = f.hit.kind;
    return k === "assignment" ? "assignments" : k === "announcement" ? "announcements" : k === "file" ? "files" : "places";
  }
  const e = f.entry;
  if (e.type === "course") return "courses";
  if (e.type === "file" || e.type === "folder") return "files";
  if (e.type === "doc") return e.kind === "assignment" ? "assignments" : e.kind === "announcement" ? "announcements" : "places";
  return "places";
}

const hitKeyOf = (h: Hit) => `hit:${h.kind}:${h.course_id}:${h.path ?? h.url ?? h.title}`;

type Term = PartOf<"word"> | PartOf<"series"> | PartOf<"kind">;
const isTerm = (p: Part): p is Term => p.role === "word" || p.role === "series" || p.role === "kind";

/** What a reading finds: by name in the catalog (and actions), and by the index (`hits`, as it
 * returns them for the reading's `indexQuery`: names first, then what's only inside). `here`: the
 * course you were last in, whose things come a little first. */
export function find(reading: Reading, catalog: Catalog, usage: Usage, hits: Hit[], actions: Action[] = [], now = Date.now(),
  here: number | null = null): Results {
  const { parts, query } = reading;
  const abbr = catalog.abbreviations;
  const courseParts = parts.filter((p): p is PartOf<"course"> => p.role === "course");
  let only: Set<number> | null = courseParts.length ? new Set(courseParts.flatMap((p) => p.courses)) : null;
  const when = parts.filter((p): p is PartOf<"when"> => p.role === "when").at(-1)?.when;
  const statuses = parts.flatMap((p) => (p.role === "status" ? [p.status] : []));
  const narrowed = !!when || statuses.length > 0;
  let terms: Term[] = parts.filter(isTerm);
  // Little words ("can I get an extension") needn't match when there's more to go by.
  if (terms.some(little) && (terms.some((t) => !little(t)) || narrowed || courseParts.length)) terms = terms.filter((t) => !little(t));
  if (!terms.length && !narrowed) {
    if (!courseParts.length) return { top: null, groups: [] };
    // Only a course: the course, and what's called that ("cs70": CS 70).
    terms = courseParts.map((p) => ({ role: "word", quoted: false, spans: p.spans, text: p.text.toLowerCase() }));
    only = null;
  }
  const picks = picked(query, usage, now);
  const ctx: Context = { catalog, usage, picks, now, here };
  const found = new Map<string, Found>();

  /** Whether it's in what the reading narrows things down to. */
  const within = (p: Prepared) => {
    if (only && (p.course === null || !only.has(p.course))) return false;
    if (when) {
      const date = when.due ? p.entry.due : p.entry.due ?? p.entry.date;
      const t = date ? Date.parse(date) : NaN;
      if (!(t >= when.from && t < when.to)) return false;
    }
    return statuses.every((s) => isStatus(p.entry, s, now));
  };
  const entries = catalog.entries.filter(within);

  // Each part, against what things are called (own) and what they're in (context).
  const last = parts.at(-1);
  const typing = (p: Part) => p === last && !/\s$/.test(query);
  const own: Map<Prepared, number>[] = [];
  const context: Map<Prepared, number>[] = [];
  for (const term of terms) {
    const text = term.text.toLowerCase();
    const mine = term.role === "series" ? new Map<Prepared, number>() : ranks(entries, text, (p) => p.names, (p) => p.aliases);
    if (term.role !== "series" && !(term.role === "word" && term.quoted)) wholeWords(entries, alternatives(text, abbr), mine);
    if (term.role === "kind") for (const p of entries) if (p.kind === term.kind) mine.set(p, Math.max(mine.get(p) ?? 0, W.kind));
    if (term.role === "series") {
      // By its number in any of the series' names (by its own a little more: "ps 3" is Problem Set
      // 3 before Homework 3); things numbered otherwise in it don't count.
      const near = new Map<string, number>();
      for (const s of catalog.series.keys()) {
        const by = seriesNear(term.name, s, abbr);
        if (by !== null) near.set(s, by);
      }
      const loose = ranks(entries, text, (p) => p.names, (p) => p.aliases);
      for (const p of entries) {
        const of = p.series.filter((s) => near.has(s.name));
        const best = (ok: (n: number) => boolean) => Math.max(...of.filter((s) => ok(s.n)).map((s) => near.get(s.name)!));
        if (of.some((s) => s.n === term.n)) mine.set(p, W.series + best((n) => n === term.n));
        else if (typing(term) && of.some((s) => String(s.n).startsWith(String(term.n)))) mine.set(p, W.series - 0.5 + best((n) => String(n).startsWith(String(term.n))));
        else if (!of.length && loose.has(p)) mine.set(p, loose.get(p)!);
      }
    }
    own.push(mine);
    context.push(term.role === "series" ? new Map() : ranks(entries, text, (p) => p.context));
  }
  const courseRank = (i: number, course: number | null) => {
    const c = course === null || terms[i].role === "series" ? undefined : catalog.courses.get(course);
    return c ? ranks([c], terms[i].text.toLowerCase(), (p) => p.names, (p) => p.aliases).get(c) ?? 0 : 0;
  };
  const courseRanks = terms.map(() => new Map<number, number>());
  const aroundOf = (i: number, p: Prepared) => {
    if (p.entry.type === "course" || p.course === null) return context[i].get(p) ?? 0;
    let c = courseRanks[i].get(p.course);
    if (c === undefined) courseRanks[i].set(p.course, (c = courseRank(i, p.course)));
    return Math.max(context[i].get(p) ?? 0, c);
  };

  for (const p of entries) {
    if (!terms.length) {
      // Narrowed down only (a time, a status): all of it, nearest in time first.
      const date = p.entry.due ?? p.entry.date;
      const days = date ? Math.abs(Date.parse(date) - now) / DAY : 30;
      found.set(p.key, { type: "thing", key: p.key, entry: p.entry, score: W.listed - Math.min(days, 30) / 15 + bonus(p, ctx) });
      continue;
    }
    let total = 0;
    let named = false;
    for (let i = 0; i < terms.length && total >= 0; i++) {
      const mine = own[i].get(p) ?? 0;
      const around = aroundOf(i, p);
      if (!mine && !around) total = -1;
      named ||= mine > 0;
      total += Math.max(mine, W.context * around);
    }
    // (What you opened after typing more than this needn't be named by it: "53" finds what
    // "53 grades" did.)
    if (total < 0 || (!named && !picks.has(p.key))) continue;
    found.set(p.key, { type: "thing", key: p.key, entry: p.entry, score: total / terms.length + bonus(p, ctx) });
  }

  // By name, as the index has it, as good as a word starting a name; and what's only inside, in
  // the index's order, with what makes things likelier counting there too.
  const inside: Found[] = [];
  const related: Found[] = []; // (what the index found by meaning, not by words: meaning.py)
  hits.forEach((h, i) => {
    const thing = thingOfHit(h);
    const p = thing ? catalog.byKey.get(thingKey(thing)) : undefined;
    if (p ? !within(p) : statuses.length > 0) return;
    const key = p ? p.key : hitKeyOf(h);
    if (h.match !== "name") {
      const score = W.inside - Math.min(i, 40) * 0.02 + (p ? bonus(p, ctx) : 0);
      const to = h.match === "meaning" ? related : inside;
      if (!found.has(key)) to.push(p ? { type: "thing", key, entry: p.entry, hit: h, score } : { type: "hit", key, hit: h, score });
      return;
    }
    const score = W.indexName - Math.min(i, 30) * 0.03;
    const had = found.get(key);
    if (had?.type === "thing") {
      had.hit = h;
      had.score = Math.max(had.score, score + (p ? bonus(p, ctx) : 0));
    } else if (p) found.set(key, { type: "thing", key, entry: p.entry, hit: h, score: score + bonus(p, ctx) });
    else found.set(key, { type: "hit", key, hit: h, score: score - 0.2 });
  });
  inside.sort((a, b) => b.score - a.score);

  // Things to do (about a course, when the reading has it; not when it's narrowed in time).
  const words = terms.filter((t): t is PartOf<"word"> => t.role === "word");
  if (!narrowed && words.length === terms.length) {
    const actionOwn = words.map((w) => ranks(actions, w.text.toLowerCase(), (a) => a.names));
    for (const a of actions) {
      if (only ? a.course === undefined || !only.has(a.course) : a.course !== undefined && !words.some((_, i) => courseRank(i, a.course!) > 0)) continue;
      let total = 0;
      let named = false;
      for (let i = 0; i < words.length && total >= 0; i++) {
        const mine = actionOwn[i].get(a) ?? 0;
        const around = a.course === undefined ? 0 : courseRank(i, a.course);
        if (!mine && !around) total = -1;
        named ||= mine > 0;
        total += Math.max(mine, W.context * around);
      }
      if (total >= 0 && named) {
        const key = `action:${a.id}`;
        found.set(key, { type: "action", key, action: a, score: total / words.length + (picks.has(key) ? W.picked : 0) });
      }
    }
  }

  const named = [...found.values()].sort((a, b) => b.score - a.score);
  const top = named[0] ?? inside.shift() ?? related.shift() ?? null;
  const groups = new Map<GroupId, Found[]>();
  for (const f of named) {
    if (f === top) continue;
    const g = groupOf(f);
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const out: Group[] = [...groups].map(([id, items]) => ({ id, items: items.slice(0, MOST), cap: CAP[id] }));
  out.sort((a, b) => b.items[0].score - a.items[0].score);
  if (inside.length) out.push({ id: "inside", items: inside.slice(0, MOST), cap: CAP.inside });
  if (related.length) out.push({ id: "related", items: related.slice(0, MOST), cap: CAP.related });
  return { top, groups: out };
}

/** What you opened lately (that's still there), latest first. */
export function recent(catalog: Catalog, usage: Usage, limit = 6): Found[] {
  return Object.entries(usage.opened)
    .sort(([, a], [, b]) => b.last.localeCompare(a.last))
    .flatMap(([key]) => {
      const p = catalog.byKey.get(key);
      return p ? [{ type: "thing" as const, key, entry: p.entry, score: 0 }] : [];
    })
    .slice(0, limit);
}

/** Assignments due in the next `days` you haven't handed in, soonest first. */
export function dueSoon(catalog: Catalog, now = Date.now(), days = 7, limit = 5): Found[] {
  return catalog.entries
    .filter((p) => {
      const due = p.entry.due ? Date.parse(p.entry.due) - now : NaN;
      return due > 0 && due < days * DAY && !handedIn(p.entry.status);
    })
    .sort((a, b) => Date.parse(a.entry.due!) - Date.parse(b.entry.due!))
    .slice(0, limit)
    .map((p) => ({ type: "thing" as const, key: p.key, entry: p.entry, score: 0 }));
}
