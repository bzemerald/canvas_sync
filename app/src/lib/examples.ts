// Example searches, made from your own courses: what the search window suggests (in its box, and
// as tips before you've opened anything). Each shows a way to search (a course's code with a
// numbered thing, an abbreviation, a kind, a time, a status, Ed) on something that's there; and
// each is proven, searched for here, to find something (by name only: search finds at least that).
import { type Catalog, type Prepared, find } from "./find";
import { t } from "./i18n";
import { type Vocabulary, key, read, shortCode } from "./query";

export type Shows = "number" | "answer" | "kind" | "due" | "status" | "ed";
export interface Example {
  query: string;
  what: string; // what it finds, in a few words
  shows: Shows;
  course: number;
}

// What's typed for each, in the app's language (the reader knows both).
const WORDS = {
  zh: { announcements: "公告", due: "本周截止", todo: "未交" }, // i18n-ignore
  en: { announcements: "announcements", due: "due this week", todo: "todo" },
};
const ANSWER = /\b(sol|sols|soln|solns|solutions?|answers?|answer key|key)\b/i;
const DAY = 864e5;

interface Candidate extends Example {
  near: number; // how far from now what it's made from is (days): nearer first
  target?: string; // the thing it's made from, which it has to find among the first
}

/** Every example the courses (`current`: their ids) give, nearest in time first, unproven. */
function candidates(catalog: Catalog, current: number[], now: number, lang: "zh" | "en", random: () => number): Candidate[] {
  const w = WORDS[lang];
  const out: Candidate[] = [];
  const word = codes(catalog);
  const name = (c: number) => catalog.courses.get(c)?.entry.name ?? "";
  const near = (p: Prepared) => {
    const d = p.entry.due ?? p.entry.date;
    return d ? Math.abs(Date.parse(d) - now) / DAY : 365;
  };
  for (const c of current) {
    const words = word.get(c);
    if (!words) continue;
    const code = words[Math.floor(random() * words.length)]; // (any of them: they all work)
    const mine = catalog.entries.filter((p) => p.course === c && p.entry.type !== "course" && p.entry.type !== "view");
    const add = (x: Omit<Candidate, "course">) => out.push({ ...x, course: c });
    for (const p of mine) {
      const s = p.series.find((x) => isSeries(x, catalog));
      if (!s) continue;
      const sw = seriesWord(s.name, catalog.abbreviations);
      const said = `${code} ${/^[a-z]{1,3}$/.test(sw) ? `${sw}${s.n}` : `${sw} ${s.n}`}`; // "hw8", "week 3"
      const own = p.entry.name ?? p.entry.title;
      if (p.entry.type === "file" && ANSWER.test(own.replace(/[_.-]/g, " "))) {
        add({ query: `${said} sol`, what: t("{course} 的答案：{name}", { course: name(c), name: own }), shows: "answer", near: near(p), target: p.key });
      } else {
        add({ query: said, what: t("{course} 的 {name}", { course: name(c), name: own }), shows: "number", near: near(p), target: p.key });
      }
    }
    const docs = (kind: string) => mine.filter((p) => p.entry.type === "doc" && p.entry.kind === kind);
    const anns = docs("announcement");
    if (anns.length) add({ query: `${code} ${w.announcements}`, what: t("{course} 的公告", { course: name(c) }), shows: "kind", near: Math.min(...anns.map(near)) });
    const hws = docs("assignment");
    const soon = hws.filter((p) => p.entry.due && Date.parse(p.entry.due) > now && Date.parse(p.entry.due) < now + 7 * DAY);
    if (soon.length) add({ query: `${code} ${w.due}`, what: t("{course} 这周要交的作业", { course: name(c) }), shows: "due", near: Math.min(...soon.map(near)) });
    const todo = hws.filter((p) => p.entry.status === "unsubmitted" && p.entry.due && Date.parse(p.entry.due) > now);
    if (todo.length) add({ query: `${code} ${w.todo}`, what: t("{course} 还没交的作业", { course: name(c) }), shows: "status", near: Math.min(...todo.map(near)) });
    const ed = mine.filter((p) => p.entry.source === "ed");
    if (ed.length) add({ query: `${code} ed`, what: t("{course} 在 Ed 上的帖子和公告", { course: name(c) }), shows: "ed", near: Math.min(...ed.map(near)) });
  }
  return out.sort((a, b) => a.near - b.near);
}

/** The words each course can be typed as in an example: its short codes with its number, no
 * other course's too ("phys7b", "7b", "physics7b"; "math53" is two courses'); else its shortest. */
function codes(catalog: Catalog): Map<number, string[]> {
  const users = new Map<string, number>();
  for (const p of catalog.courses.values()) for (const k of p.entry.keys ?? []) users.set(k, (users.get(k) ?? 0) + 1);
  const out = new Map<number, string[]>();
  for (const [id, p] of catalog.courses) {
    const keys = p.entry.keys ?? [];
    const own = keys.filter((k) => users.get(k) === 1 && k.length <= 10 && /\d/.test(k));
    const words = own.length ? own : [shortCode(keys)].filter((k): k is string => !!k);
    if (words.length) out.set(id, words);
  }
  return out;
}

/** Whether a numbered word is one of a series ("hw 3", "lecture 9"): one numbered more than once,
 * not a term ("fa 26"), a course's code ("neu 100") or an answer ("sol 14"). */
function isSeries(s: { name: string; n: number }, catalog: Catalog): boolean {
  if (/^(fa|sp|su|wi|fall|spring|summer|winter|autumn)$/.test(s.name) || ANSWER.test(s.name)) return false;
  if ([...catalog.courses.values()].some((c) => (c.entry.keys ?? []).some((k) => k.startsWith(key(s.name) + s.n)))) return false;
  return (catalog.series.get(s.name)?.size ?? 0) > 1;
}

/** What a series is typed as: its shortest abbreviation ("homework": hw), else itself. */
function seriesWord(series: string, abbr: Record<string, string[]>): string {
  const short = Object.entries(abbr).filter(([a, xs]) => /^[a-z]+$/.test(a) && xs[0] === series).map(([a]) => a);
  return [series, ...short].sort((a, b) => a.length - b.length)[0];
}

/** Whether searching for it finds something; and, made from a thing, that thing among the first. */
function proven(x: Candidate, catalog: Catalog, vocab: Vocabulary, now: number): boolean {
  const r = find(read(x.query, vocab, now), catalog, { opened: {}, picks: [] }, [], [], now);
  const all = [...(r.top ? [r.top] : []), ...r.groups.flatMap((g) => g.items)];
  if (!all.length) return false;
  return !x.target || all.slice(0, 3).some((f) => f.key === x.target);
}

/** Up to `n` examples, one of each way, from different courses where they can be; which ones
 * (among the nearest few of each) as `random` has it, so others come up over time. */
export function examples(catalog: Catalog, vocab: Vocabulary, current: number[], now: number, lang: "zh" | "en",
  n = 6, random: () => number = Math.random): Example[] {
  const all = candidates(catalog, current, now, lang, random);
  const ways = [...new Set(all.map((x) => x.shows))];
  // The ways in a random order (a numbered thing first, though: what search does best).
  ways.sort((a, b) => (a === "number" ? -1 : b === "number" ? 1 : random() - 0.5));
  const chosen: Example[] = [];
  const courses = new Set<number>();
  for (const way of ways) {
    if (chosen.length >= n) break;
    const few = all.filter((x) => x.shows === way).slice(0, 8);
    // Another course first; then the rest; each in a random order, nearest a little likelier.
    const order = (xs: Candidate[]) => xs.map((x, i) => ({ x, r: random() + i / 8 })).sort((a, b) => a.r - b.r).map((o) => o.x);
    const pick = [...order(few.filter((x) => !courses.has(x.course))), ...order(few.filter((x) => courses.has(x.course)))]
      .find((x) => proven(x, catalog, vocab, now));
    if (!pick) continue;
    chosen.push({ query: pick.query, what: pick.what, shows: pick.shows, course: pick.course });
    courses.add(pick.course);
  }
  return chosen;
}

/** Random numbers, the same ones for the same seed (the same examples while the window is up). */
export function seeded(seed: number): () => number {
  let s = (seed * 2654435761) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
