// Search as you type: everything there is to go to, by name (the catalog: courses, their views,
// documents, modules, tools, files and folders, what you put in places), and what the index finds
// by the text inside. What it finds comes in groups, the best of all on top. What you open most,
// and lately, comes first; what you opened after typing the same, on top.
//
// Matching is match-sorter's, word by word: each word of the query has to match what a thing is
// called (its own names) or what it's in (its course, its kind, its folders), and at least one
// word its own names. "cs70 grades" is CS 70's 成绩; "cs70" alone, the course.
//
// Nothing here draws or says anything (no i18n): what things are called comes from `describe`.
import { matchSorterWithRankInfo, rankings } from "match-sorter";
import type { CatalogEntry, Hit, Usage } from "./api";
import { termRank } from "./terms";
import { thingKey, thingOfHit } from "./things";

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

export type GroupId = "courses" | "places" | "assignments" | "announcements" | "files" | "actions" | "inside";
export interface Group {
  id: GroupId;
  items: Found[]; // best first (all of them: `cap` is how many to show unless asked for all)
  cap: number;
}
export interface Results {
  top: Found | null;
  groups: Group[]; // the best group first; what's only inside last
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
  term: number; // its course's term (termRank)
}

/** The catalog, made ready for matching (once, when it's loaded). */
export interface Catalog {
  entries: Prepared[];
  byKey: Map<string, Prepared>;
  courses: Map<number, Prepared>;
  latestTerm: number;
}

const CAP: Record<GroupId, number> = { courses: 3, places: 5, assignments: 4, announcements: 4, files: 5, actions: 3, inside: 5 };
const MOST = 50; // shown in a group asked for all
const DAY = 24 * 3600 * 1000;

// Separators people don't type, where letters meet digits or a capital starts a word, and leading
// zeros: "lec-02_v2.pdf" is "lec 2 v 2 pdf"; "midtermReview" is "midterm Review".
const SEP = /[\s_\-./\\()[\]{},:;#+~]+/g;
const WORD_BREAK = /(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})|(?<=\p{Ll})(?=\p{Lu})/gu;
export const spaced = (s: string) => s.replace(SEP, " ").replace(WORD_BREAK, " ").replace(/\b0+(?=\d)/g, "").trim();
const variants = (s: string) => [...new Set([s, spaced(s)].filter(Boolean))];

export function prepare(things: CatalogEntry[], describe: Describe): Catalog {
  const terms = new Map<number, number>();
  for (const e of things) if (e.type === "course") terms.set(e.course, termRank(e.term ?? null));
  const entries = things.map((entry): Prepared => {
    const { names, aliases, kind } = describe(entry);
    const folders = entry.type === "file" || entry.type === "folder" ? entry.path.split("/").slice(-3, -1) : [];
    const own = [...new Set(names.filter(Boolean).flatMap(variants))];
    return {
      entry,
      key: thingKey(entry),
      names: own,
      aliases: [...new Set(aliases.filter(Boolean).flatMap(variants))].filter((a) => !own.includes(a)),
      context: [...new Set([...kind, ...folders].filter(Boolean).flatMap(variants))],
      term: entry.in_course !== null ? terms.get(entry.in_course) ?? 0 : 0,
    };
  });
  return {
    entries,
    byKey: new Map(entries.map((p) => [p.key, p])),
    courses: new Map(entries.flatMap((p) => (p.entry.type === "course" ? [[p.entry.course, p] as const] : []))),
    latestTerm: Math.max(0, ...terms.values()),
  };
}

/** The words of a query (lower-cased, as typed: "cs70 hw3"). */
export const words = (query: string) => query.toLowerCase().split(/\s+/).filter((w) => spaced(w));
const normal = (query: string) => words(query).join(" ");

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/** A word's match good enough to count: it starts a word (or is a word's initials), as in
 * Spotlight: "sync" isn't "asynchronous". Chinese has no spaces between words: anywhere in it. */
function counts(rank: number, word: string): boolean {
  if (rank >= rankings.WORD_STARTS_WITH) return true;
  if (rank === rankings.CONTAINS) return CJK.test(word);
  return rank === rankings.ACRONYM && word.replace(/\s/g, "").length >= 2;
}

const ALIAS = 0.25; // less for matching only what else a thing answers to, not what it's shown as

/** How well `word` matches each item's values (`values`, then `others`: a little less), by item;
 * the best of the word as typed and spaced out. */
function ranks<T>(items: T[], word: string, values: (item: T) => string[], others?: (item: T) => string[]): Map<T, number> {
  const out = new Map<T, number>();
  for (const alt of variants(word)) {
    const keys = others ? [values, others] : [values];
    for (const r of matchSorterWithRankInfo(items, alt, { keys, threshold: rankings.ACRONYM, sorter: (x) => x })) {
      if (!counts(r.rank, alt)) continue;
      const rank = Math.min(r.rank, rankings.EQUAL) - (r.keyIndex > 0 ? ALIAS : 0);
      out.set(r.item, Math.max(out.get(r.item) ?? 0, rank));
    }
  }
  return out;
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

/** What makes one thing better than another that matches as well. */
function bonus(p: Prepared, catalog: Catalog, usage: Usage, picks: Map<string, number>, now: number): number {
  const e = p.entry;
  let b = 0.5 * Math.min(frecency(usage.opened[p.key], now), 4);
  const pick = picks.get(p.key) ?? 0;
  if (pick > 0) b += 3 + Math.min(pick, 3);
  if (e.type === "course") b += 0.6;
  else if (e.type === "view") b += 0.2;
  if (p.term && p.term === catalog.latestTerm) b += 1; // (what was last term's is seldom what you're after)
  const due = e.due ? Date.parse(e.due) - now : NaN;
  if (due > 0 && due < 7 * DAY && !handedIn(e.status)) b += 0.3;
  const age = e.date ? (now - Date.parse(e.date)) / DAY : NaN;
  if (age >= 0 && age < 14) b += 0.2 * (1 - age / 14);
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

/** What `query` finds: by name in the catalog (and actions), and by the index (`hits`, as /search
 * returns them for the query: names first, then what's only inside). */
export function find(query: string, catalog: Catalog, usage: Usage, hits: Hit[], actions: Action[] = [], now = Date.now()): Results {
  const ws = words(query);
  if (!ws.length) return { top: null, groups: [] };
  const picks = picked(query, usage, now);
  const found = new Map<string, Found>();

  // By name: each word against what things are called, and what they're in.
  const own = ws.map((w) => ranks(catalog.entries, w, (p) => p.names, (p) => p.aliases));
  const context = ws.map((w) => ranks(catalog.entries, w, (p) => p.context));
  const courseRank = (i: number, course: number | null) => {
    const c = course === null ? undefined : catalog.courses.get(course);
    return c ? own[i].get(c) ?? 0 : 0;
  };
  for (const p of catalog.entries) {
    let total = 0;
    let named = false;
    for (let i = 0; i < ws.length && total >= 0; i++) {
      const mine = own[i].get(p) ?? 0;
      const around = Math.max(context[i].get(p) ?? 0, courseRank(i, p.entry.in_course));
      if (!mine && !around) total = -1;
      named ||= mine > 0;
      total += Math.max(mine, 0.5 * around);
    }
    // (What you opened after typing more than this needn't be named by it: "53" finds what
    // "53 grades" did.)
    if (total < 0 || (!named && !picks.has(p.key))) continue;
    found.set(p.key, { type: "thing", key: p.key, entry: p.entry, score: total / ws.length + bonus(p, catalog, usage, picks, now) });
  }

  // By name, as the index has it (it knows "mt" is a midterm), as good as a word starting a name.
  const inside: Found[] = [];
  hits.forEach((h, i) => {
    const thing = thingOfHit(h);
    const p = thing ? catalog.byKey.get(thingKey(thing)) : undefined;
    const key = p ? p.key : hitKeyOf(h);
    if (h.match !== "name") {
      if (!found.has(key)) inside.push(p ? { type: "thing", key, entry: p.entry, hit: h, score: 0 } : { type: "hit", key, hit: h, score: 0 });
      return;
    }
    const score = rankings.WORD_STARTS_WITH + 0.2 - Math.min(i, 30) * 0.03;
    const had = found.get(key);
    if (had?.type === "thing") {
      had.hit = h;
      had.score = Math.max(had.score, score + (p ? bonus(p, catalog, usage, picks, now) : 0));
    } else if (p) found.set(key, { type: "thing", key, entry: p.entry, hit: h, score: score + bonus(p, catalog, usage, picks, now) });
    else found.set(key, { type: "hit", key, hit: h, score: score - 0.2 });
  });

  // Things to do.
  const actionOwn = ws.map((w) => ranks(actions, w, (a) => a.names));
  for (const a of actions) {
    let total = 0;
    let named = false;
    let about = a.course === undefined;
    for (let i = 0; i < ws.length && total >= 0; i++) {
      const mine = actionOwn[i].get(a) ?? 0;
      const around = courseRank(i, a.course ?? null);
      if (!mine && !around) total = -1;
      named ||= mine > 0;
      about ||= around > 0;
      total += Math.max(mine, 0.5 * around);
    }
    if (total >= 0 && named && about) {
      const key = `action:${a.id}`;
      found.set(key, { type: "action", key, action: a, score: total / ws.length + (picks.has(key) ? 3 : 0) });
    }
  }

  const named = [...found.values()].sort((a, b) => b.score - a.score);
  const top = named[0] ?? inside.shift() ?? null;
  const groups = new Map<GroupId, Found[]>();
  for (const f of named) {
    if (f === top) continue;
    const g = groupOf(f);
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const out: Group[] = [...groups].map(([id, items]) => ({ id, items: items.slice(0, MOST), cap: CAP[id] }));
  out.sort((a, b) => b.items[0].score - a.items[0].score);
  if (inside.length) out.push({ id: "inside", items: inside.slice(0, MOST), cap: CAP.inside });
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
