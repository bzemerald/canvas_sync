// What a search query says. Words, to find things by (by name: find.ts; by the text inside: the
// index), and what narrows it down, read from what people type, in either language:
//   a course   "cs70", "math 53", "53": its code or number, or a name you gave it
//   a kind     "公告", "assignments", "files": what's of that kind answers to it (so "cs70 公告" is
//              CS 70's announcements), as does what's called that
//   a time     "today", "this week", "next friday", "10/20", "oct 20", "明天", "本周", "周五",
//              "10月20日"; "due" says it's when something is due (alone: not due yet)
//   a status   "todo" / "未交", "missing" / "缺交", "overdue" / "逾期", "submitted" / "已交",
//              "graded" / "已评分": where you are with an assignment
//   a number   "hw3", "hw 3", "homework #3", "problem set 3", "2nd midterm", "第三次作业", "期中2":
//              one of a series, whatever its course calls the series (see `sameSeries`)
// Or said outright: in:cs70, kind:file, due:friday, date:10/20, is:missing; "in quotes": only as
// text. Each part keeps where it was typed, to be shown as a chip (and taken back, or taken as text).
//
// Nothing here says anything (no i18n): the words are what people type; the app's own names for
// courses and kinds come in `Vocabulary`.

export type KindId = "course" | "announcement" | "assignment" | "page" | "post" | "module" | "tool" | "link" | "note" | "search" | "file" | "folder";
export type Status = "todo" | "missing" | "overdue" | "submitted" | "graded";
export type Span = readonly [number, number];

/** When, as it was said: a day (its start), a week (0: this one, 1: next...), a month (0: this
 * one), a month by its start, this weekend, the next 7 days, from now on, the last 14 days. */
export type WhenLabel =
  | { day: number }
  | { week: number }
  | { month: number }
  | { monthOf: number }
  | { weekend: true }
  | { soon: true }
  | { later: true }
  | { lately: true };
/** From `from` up to `to` (ms); `due`: when it's due, not when it's from. */
export interface When { from: number; to: number; due: boolean; label: WhenLabel }

interface Said {
  spans: Span[]; // where it was typed (more than one place: "本周 … 截止")
  text: string; // what was typed (the first span's)
}
export type Part = Said & (
  | { role: "word"; quoted: boolean; was?: string } // was: what was typed, taken for this (misspelled)
  | { role: "series"; name: string; n: number; was?: string }
  | { role: "course"; courses: number[] }
  | { role: "kind"; kind: KindId }
  | { role: "when"; when: When }
  | { role: "status"; status: Status }
);
export type PartOf<R extends Part["role"]> = Extract<Part, { role: R }>;

export interface Reading {
  query: string;
  parts: Part[];
}

/** What the reader knows of what's there. */
export interface Vocabulary {
  courses: { id: number; keys: string[] }[]; // what each course is as one word (`key`'d: "cs70", "53", "线代")
  kinds: Record<string, KindId>; // kind words, lower-cased, as the app says them (both languages)
  series: Map<string, Set<number>>; // the series in names ("problem set", "lab") and their numbers
  abbreviations: Record<string, string[]>; // "hw" -> homework, problem set... (built in, and yours)
}

export const NO_VOCABULARY: Vocabulary = { courses: [], kinds: {}, series: new Map(), abbreviations: {} };

// -- words ------------------------------------------------------------------------------------

export const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const CJK_RUN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]+/g;

// Separators people don't type, where letters meet digits or a capital starts a word, and leading
// zeros: "lec-02_v2.pdf" is "lec 2 v 2 pdf"; "midtermReview" is "midterm Review".
const SEP = /[\s_\-./\\()[\]{},:;#+~]+/g;
const WORD_BREAK = /(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})|(?<=\p{Ll})(?=\p{Lu})/gu;
export const spaced = (s: string) => s.replace(SEP, " ").replace(WORD_BREAK, " ").replace(/\b0+(?=\d)/g, "").trim();

/** Letters and digits only, lower-cased: how course words are compared ("CS 70" is "cs70"). */
export const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A word without its plural ending ("labs": lab, "quizzes": quiz; "class" stays). Of a phrase,
 * the last word's. */
export function singular(w: string): string {
  const cut = w.lastIndexOf(" ");
  if (cut >= 0) return w.slice(0, cut + 1) + singular(w.slice(cut + 1));
  if (w.length <= 3 || !w.endsWith("s") || /(ss|us|is)$/.test(w)) return w;
  if (w.endsWith("zzes")) return w.slice(0, -3);
  if (/(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  return w.slice(0, -1);
}

// -- series -----------------------------------------------------------------------------------

const wordish = (w: string) => /^\p{Ll}{2,}$/u.test(w) || CJK.test(w);

/** The numbered things a name is: "Homework 3: RISC-V" is homework 3, "EE64_FA26_HW6_Sol.pdf"
 * hw 6, "Problem Set #3" problem set 3 (and set 3), "第3讲" 讲 3. */
export function seriesIn(name: string): { name: string; n: number }[] {
  const said = spaced(name).split(" ");
  const ws = said.map((w) => w.toLowerCase());
  const out: { name: string; n: number }[] = [];
  for (let i = 1; i < ws.length; i++) {
    const n = /^\d{1,4}$/.test(ws[i]) ? Number(ws[i]) : said[i] === "I" ? 1 : ROMAN[ws[i]];
    if (n === undefined) continue;
    const before = ws[i - 1];
    if (before === "第") { // i18n-ignore
      const after = (ws[i + 1] ?? "").replace(/^[次个]/, ""); // i18n-ignore
      if (after && CJK.test(after)) out.push({ name: after, n });
    } else if (wordish(before)) {
      out.push({ name: before, n });
      if (i > 1 && wordish(ws[i - 2]) && !CJK.test(before)) out.push({ name: `${ws[i - 2]} ${before}`, n });
    }
  }
  return out;
}
// "Midterm II", "Topics IV" ("V" and "X" alone are too often something else: RISC-V).
const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 };

/** Whether a series as typed (`a`) is one a name has (`b`): the same word ("lab", "labs"), the
 * start of it ("lec", "lecture"), its initials ("ps", "problem set"), one of its abbreviations,
 * either way or both of the same ("hw" and "homework", "mt" and "prelim", "作业" and "hw"); or,
 * for words with none, letters of it in order ("ws", "worksheet"). */
export function sameSeries(a: string, b: string, abbr: Record<string, string[]>): boolean {
  return seriesNear(a, b, abbr) !== null;
}

/** How near a series as typed is to one a name has (see `sameSeries`): 0 by its own name
 * (shortened or not), less by an abbreviation of it ("hw" for "problem set"); null: not it. */
export function seriesNear(a: string, b: string, abbr: Record<string, string[]>): number | null {
  a = singular(a);
  b = singular(b);
  if (a === b || a.replace(/ /g, "") === b.replace(/ /g, "")) return 0; // ("prelab", "PreLab": pre lab)
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return 0;
  if (long.includes(" ") && !short.includes(" ") && short === long.split(" ").map((w) => w[0]).join("")) return 0;
  const of = (w: string) => (abbr[w] ?? []).map(singular);
  const ofA = of(a);
  const ofB = of(b);
  if (ofA.includes(b) || ofB.includes(a)) return letters(short, long) ? 0 : -0.1; // ("hw": homework 0, problem set -0.1)
  if (ofA.some((x) => ofB.includes(x))) return -0.5; // ("ps" and "hw": both homework, but "ps" says a problem set)
  if (abbr[short] || short.length * 2 > long.replace(/ /g, "").length) return null;
  return letters(short, long) ? 0 : null;
}

/** Whether `short` is `long` with letters left out: its first, then the rest in order ("ws",
 * "worksheet"). */
function letters(short: string, long: string): boolean {
  const flat = long.replace(/ /g, "");
  if (short.length < 2 || CJK.test(short) || flat[0] !== short[0]) return false;
  let j = 1;
  for (let i = 1; i < flat.length && j < short.length; i++) if (flat[i] === short[j]) j++;
  return j === short.length;
}

// -- reading ----------------------------------------------------------------------------------

interface Tok {
  low: string; // as typed, lower-cased
  start: number;
  end: number;
  quoted?: boolean;
  syntax?: string; // in, kind, due, date, is
  cjk?: boolean;
  num?: number; // a number: "3", "#3", "03", "三"
  nth?: boolean; // "第 3": the third
}

const SYNTAX = /^(in|kind|type|due|date|on|is)[:：]/i;
const NUMERAL = /^[一二两三四五六七八九十]+$/; // i18n-ignore

/** 一 to 九十九, as a number. */
function numeral(s: string): number | undefined {
  const d = "一二三四五六七八九"; // i18n-ignore
  const digit = (c: string) => (c === "两" ? 2 : d.indexOf(c) + 1); // i18n-ignore
  if (!NUMERAL.test(s)) return undefined;
  const ten = s.indexOf("十"); // i18n-ignore
  if (ten < 0) return s.length === 1 ? digit(s) : undefined;
  const tens = ten === 0 ? 1 : digit(s.slice(0, ten));
  const ones = s.length > ten + 1 ? digit(s.slice(ten + 1)) : 0;
  return s.length <= 3 && tens > 0 && ones >= 0 ? tens * 10 + ones : undefined;
}

const WEEKDAY_ZH = "一二三四五六日天"; // i18n-ignore
// Chinese words the reader knows, so a run of Chinese can be told apart ("本周截止的作业").
const TIME_ZH: Record<string, number | string> = {
  今天: 0, 今日: 0, 今晚: 0, 明天: 1, 明日: 1, 明晚: 1, 后天: 2, 昨天: -1, 昨日: -1, 昨晚: -1, 前天: -2, // i18n-ignore
  本周: "w0", 这周: "w0", 这星期: "w0", 这个星期: "w0", 本星期: "w0", 这礼拜: "w0", 这个礼拜: "w0", // i18n-ignore
  下周: "w1", 下星期: "w1", 下个星期: "w1", 下礼拜: "w1", 下个礼拜: "w1", // i18n-ignore
  上周: "w-1", 上星期: "w-1", 上个星期: "w-1", 上礼拜: "w-1", 上个礼拜: "w-1", // i18n-ignore
  本月: "m0", 这个月: "m0", 这月: "m0", 下个月: "m1", 下月: "m1", 上个月: "m-1", 上月: "m-1", // i18n-ignore
  周末: "weekend", 最近: "lately", 近期: "soon", 即将: "soon", // i18n-ignore
};
for (const [prefix, week] of [["", 0], ["这", 0], ["本", 0], ["这个", 0], ["下", 1], ["下个", 1], ["上", -1], ["上个", -1]] as const) { // i18n-ignore
  for (const unit of ["周", "星期", "礼拜"]) { // i18n-ignore
    for (const [i, d] of [...WEEKDAY_ZH].entries()) TIME_ZH[prefix + unit + d] = `d${week},${Math.min(i, 6)}`;
  }
}
const DUE_ZH = ["截止", "到期", "截止日期", "截至"]; // i18n-ignore
const STATUS_ZH: Record<string, Status> = {
  未交: "todo", 没交: "todo", 未提交: "todo", 没提交: "todo", 还没交: "todo", 没有交: "todo", 待交: "todo", 待提交: "todo", 待办: "todo", // i18n-ignore
  缺交: "missing", 漏交: "missing", 逾期: "overdue", 过期: "overdue", 已截止: "overdue", // i18n-ignore
  已交: "submitted", 已提交: "submitted", 交了: "submitted", 已评分: "graded", 已打分: "graded", 出分: "graded", 已出分: "graded", 有成绩: "graded", // i18n-ignore
};
const UNITS_ZH = ["次", "个", "周", "讲", "章", "节", "课", "单元", "月", "日", "号", "第"]; // i18n-ignore
const STOP_ZH = new Set(["的", "里", "之"]); // i18n-ignore

const WEEKDAYS: Record<string, number> = {
  monday: 0, mon: 0, tuesday: 1, tue: 1, tues: 1, wednesday: 2, wed: 2, weds: 2, thursday: 3, thu: 3, thur: 3, thurs: 3,
  friday: 4, fri: 4, saturday: 5, sat: 5, sunday: 6, sun: 6,
};
const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
const STATUS_EN: [string[], Status][] = [
  [["not", "submitted"], "todo"], [["not", "handed", "in"], "todo"], [["not", "turned", "in"], "todo"], [["to", "do"], "todo"],
  [["past", "due"], "overdue"], [["handed", "in"], "submitted"], [["turned", "in"], "submitted"],
  [["todo"], "todo"], [["to-do"], "todo"], [["unsubmitted"], "todo"], [["missing"], "missing"], [["overdue"], "overdue"],
  [["submitted"], "submitted"], [["graded"], "graded"],
];

/** The Chinese words a reader with `v` knows (longest first is how they're found). */
const known = new WeakMap<Vocabulary, Set<string>>();
function chineseWords(v: Vocabulary): Set<string> {
  let words = known.get(v);
  if (!words) {
    words = new Set([...Object.keys(TIME_ZH), ...DUE_ZH, ...Object.keys(STATUS_ZH), ...UNITS_ZH, ...STOP_ZH]);
    for (const w of [...Object.keys(v.kinds), ...Object.keys(v.abbreviations), ...v.courses.flatMap((c) => c.keys)]) if (CJK.test(w)) words.add(w);
    known.set(v, words);
  }
  return words;
}

/** A run of Chinese, in words: those known, longest first ("第" with a number after it is one),
 * and the rest as they come. */
function chinese(run: string, at: number, words: Set<string>): Tok[] {
  const out: Tok[] = [];
  let rest = "";
  let restAt = at;
  const flush = (end: number) => {
    if (rest) out.push({ low: rest, start: restAt, end, cjk: true, num: numeral(rest) });
    rest = "";
  };
  for (let i = 0; i < run.length; ) {
    let len = 0;
    if (run[i] === "第") { // i18n-ignore
      while (i + 1 + len < run.length && NUMERAL.test(run[i + 1 + len])) len++;
      if (len) {
        flush(at + i);
        out.push({ low: run.slice(i, i + 1 + len), start: at + i, end: at + i + 1 + len, cjk: true, num: numeral(run.slice(i + 1, i + 1 + len)), nth: true });
        i += 1 + len;
        continue;
      }
    }
    for (let l = Math.min(6, run.length - i); l > 0; l--) {
      if (words.has(run.slice(i, i + l))) {
        len = l;
        break;
      }
    }
    if (!len) {
      if (!rest) restAt = at + i;
      rest += run[i++];
      continue;
    }
    flush(at + i);
    out.push({ low: run.slice(i, i + len), start: at + i, end: at + i + len, cjk: true });
    i += len;
    // A number after a word ("作业三", "期中二").
    let n = 0;
    while (i + n < run.length && NUMERAL.test(run[i + n])) n++;
    if (n && numeral(run.slice(i, i + n)) !== undefined) {
      out.push({ low: run.slice(i, i + n), start: at + i, end: at + i + n, cjk: true, num: numeral(run.slice(i, i + n)) });
      i += n;
    }
  }
  flush(at + run.length);
  return out;
}

const NUMBER = /^#?0*(\d{1,4})$/;

/** The query in pieces: quoted, said outright (in:…), Chinese words, and the rest by spaces. */
function tokens(q: string, v: Vocabulary): Tok[] {
  const out: Tok[] = [];
  const words = chineseWords(v);
  const piece = (text: string, at: number) => {
    let last = 0;
    for (const m of text.matchAll(CJK_RUN)) {
      if (m.index > last) latin(text.slice(last, m.index), at + last);
      out.push(...chinese(m[0], at + m.index, words));
      last = m.index + m[0].length;
    }
    if (last < text.length) latin(text.slice(last), at + last);
  };
  const latin = (text: string, at: number) => {
    const low = text.toLowerCase().replace(/[,?!;。，？！；、]+$/u, "");
    if (!low) return;
    const n = low.match(NUMBER);
    out.push({ low, start: at, end: at + low.length, num: n ? Number(n[1]) : undefined });
  };
  for (let i = 0; i < q.length; ) {
    if (/\s/.test(q[i])) {
      i++;
      continue;
    }
    if (q[i] === '"' || q[i] === "“") {
      const close = q.slice(i + 1).search(/["”]/);
      const end = close < 0 ? q.length : i + 1 + close;
      const text = q.slice(i + 1, end).trim();
      if (text) out.push({ low: text.toLowerCase(), start: i, end: Math.min(q.length, end + 1), quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < q.length && !/\s/.test(q[j])) j++;
    const m = q.slice(i, j).match(SYNTAX);
    if (m) {
      let end = j;
      let value = q.slice(i + m[0].length, j);
      if (value.startsWith('"')) {
        const close = q.indexOf('"', i + m[0].length + 1);
        end = close < 0 ? q.length : close + 1;
        value = q.slice(i + m[0].length + 1, close < 0 ? q.length : close);
      }
      out.push({ low: value.toLowerCase().trim(), start: i, end, syntax: m[1].toLowerCase() === "type" ? "kind" : m[1].toLowerCase() === "on" ? "date" : m[1].toLowerCase() });
      i = end;
      continue;
    }
    piece(q.slice(i, j), i);
    i = j;
  }
  // "第 3" is the third.
  return out.flatMap((t, i) => {
    const prev = out[i - 1];
    if (prev?.low === "第" && t.num !== undefined && t.start === prev.end) return []; // i18n-ignore
    const next = out[i + 1];
    if (t.low === "第" && next?.num !== undefined && next.start === t.end) return [{ ...t, low: "第" + next.low, end: next.end, num: next.num, nth: true }]; // i18n-ignore
    return [t];
  });
}

// -- times ------------------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
const dayStart = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const addDays = (t: number, n: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};
const weekStart = (t: number) => addDays(dayStart(t), -((new Date(t).getDay() + 6) % 7)); // (Monday)
const monthStart = (t: number, offset: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime();
};

function day(t: number): When {
  const from = dayStart(t);
  return { from, to: addDays(from, 1), due: false, label: { day: from } };
}
const week = (now: number, offset: number): When => {
  const from = addDays(weekStart(now), 7 * offset);
  return { from, to: addDays(from, 7), due: false, label: { week: offset } };
};
const month = (now: number, offset: number): When => ({ from: monthStart(now, offset), to: monthStart(now, offset + 1), due: false, label: { month: offset } });
/** Day `d` (0: Monday) of the week `offset` weeks from this one. */
const weekday = (now: number, offset: number, d: number) => day(addDays(weekStart(now), 7 * offset + d));
/** The next day `d` (0: Monday), today if it's that day. */
const coming = (now: number, d: number) => day(addDays(dayStart(now), (d - ((new Date(now).getDay() + 6) % 7) + 7) % 7));
/** Month `m` (0-based) day `d`, in the year that puts it nearest to now. */
function date(now: number, m: number, d: number, y?: number): When | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const year = new Date(now).getFullYear();
  const at = (yy: number) => new Date(yy, m, d).getTime();
  let t = at(y !== undefined ? (y < 100 ? 2000 + y : y) : year);
  if (y === undefined) {
    if (t - now > 183 * DAY_MS) t = at(year - 1);
    else if (now - t > 183 * DAY_MS) t = at(year + 1);
  }
  return new Date(t).getDate() === d ? day(t) : null;
}

/** Month `m` (0-based), in the year that puts it nearest to now. */
function monthOf(now: number, m: number): When {
  const year = new Date(now).getFullYear();
  let from = new Date(year, m, 1).getTime();
  if (from - now > 183 * DAY_MS) from = new Date(year - 1, m, 1).getTime();
  else if (now - from > 214 * DAY_MS) from = new Date(year + 1, m, 1).getTime();
  return { from, to: monthStart(from, 1), due: false, label: { monthOf: from } };
}
const soon = (now: number): When => ({ from: now, to: now + 7 * DAY_MS, due: false, label: { soon: true } });
const lately = (now: number): When => ({ from: addDays(dayStart(now), -14), to: addDays(dayStart(now), 1), due: false, label: { lately: true } });
const weekend = (now: number): When => ({ from: addDays(weekStart(now), 5), to: addDays(weekStart(now), 7), due: false, label: { weekend: true } });

/** A time said in tokens from `i`: how many it took, and when. `outright`: said as one (due:fri),
 * so words that could be something else ("sat", "may") are taken as times. */
function time(ts: Tok[], i: number, now: number, outright = false): { take: number; when: When } | null {
  const t = ts[i];
  if (!t || t.quoted || t.syntax) return null;
  const w = t.low;
  const next = ts[i + 1]?.low ?? "";
  // 10月20日, 十月二十号, 10月
  if (t.num !== undefined && next === "月" && ts[i + 1].start === t.end) { // i18n-ignore
    const d = ts[i + 2];
    if (d?.num !== undefined && d.start === ts[i + 1].end) {
      const when = date(now, t.num - 1, d.num);
      const unit = ["日", "号"].includes(ts[i + 3]?.low ?? "") && ts[i + 3].start === d.end ? 1 : 0; // i18n-ignore
      if (when) return { take: 3 + unit, when };
    }
    if (t.num >= 1 && t.num <= 12) return { take: 2, when: monthOf(now, t.num - 1) };
  }
  if (t.cjk) {
    const zh = TIME_ZH[w];
    if (typeof zh === "number") return { take: 1, when: day(addDays(now, zh)) };
    if (zh === "weekend") return { take: 1, when: weekend(now) };
    if (zh === "lately") return { take: 1, when: lately(now) };
    if (zh === "soon") return { take: 1, when: soon(now) };
    if (typeof zh === "string") {
      const n = zh.slice(1);
      if (zh[0] === "w") return { take: 1, when: week(now, Number(n)) };
      if (zh[0] === "m") return { take: 1, when: month(now, Number(n)) };
      const [wk, d] = n.split(",").map(Number);
      return { take: 1, when: weekday(now, wk, d) };
    }
    return null;
  }
  if (w === "today" || w === "tonight") return { take: 1, when: day(now) };
  if (w === "tomorrow" || w === "tmr" || w === "tmrw") return { take: 1, when: day(addDays(now, 1)) };
  if (w === "yesterday") return { take: 1, when: day(addDays(now, -1)) };
  if (w === "upcoming" || w === "soon") return { take: 1, when: soon(now) };
  if (w === "recent" || w === "recently" || w === "latest" || w === "lately") return { take: 1, when: lately(now) };
  if (w === "weekend") return { take: 1, when: weekend(now) };
  const offset = w === "this" ? 0 : w === "next" ? 1 : w === "last" ? -1 : null;
  if (offset !== null) {
    if (next === "week") return { take: 2, when: week(now, offset) };
    if (next === "month") return { take: 2, when: month(now, offset) };
    if (next === "weekend" && offset === 0) return { take: 2, when: weekend(now) };
    if (next in WEEKDAYS) return { take: 2, when: weekday(now, offset, WEEKDAYS[next]) };
    return null;
  }
  // A weekday alone: the coming one. ("sat", "sun", "wed" alone could be words.)
  if (w in WEEKDAYS && (w.length > 4 || outright)) return { take: 1, when: coming(now, WEEKDAYS[w]) };
  // oct 20, oct 20th, 20 oct, 10/20, 10/20/26, 2026-10-20
  const dayNum = (s: string) => s.match(/^(\d{1,2})(st|nd|rd|th)?,?$/)?.[1];
  const monthName = (s: string) => MONTHS[s.replace(/[.,]$/, "")];
  if (monthName(w) !== undefined && dayNum(next)) {
    const when = date(now, monthName(w), Number(dayNum(next)));
    if (when) return { take: 2, when };
  }
  if (dayNum(w) && monthName(next) !== undefined) {
    const when = date(now, monthName(next), Number(dayNum(w)));
    if (when) return { take: 2, when };
  }
  let m = w.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (m) {
    const when = date(now, Number(m[1]) - 1, Number(m[2]), m[3] ? Number(m[3]) : undefined);
    if (when) return { take: 1, when };
  }
  m = w.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const when = date(now, Number(m[2]) - 1, Number(m[3]), Number(m[1]));
    if (when) return { take: 1, when };
  }
  if (outright && monthName(w) !== undefined) return { take: 1, when: monthOf(now, monthName(w)) };
  return null;
}

const isDue = (t: Tok | undefined) => !!t && !t.quoted && !t.syntax && (["due", "deadline", "deadlines", "ddl"].includes(t.low) || DUE_ZH.includes(t.low));

// -- everything -------------------------------------------------------------------------------

const span = (...ts: Tok[]): Span => [ts[0].start, ts[ts.length - 1].end];

/** What `query` says, with what's known (`v`) and the time now (`now`: for "today"). */
export function read(query: string, v: Vocabulary = NO_VOCABULARY, now = Date.now()): Reading {
  const ts = tokens(query, v);
  const parts: Part[] = [];
  const courseKeys = new Map<string, number[]>();
  for (const c of v.courses) for (const k of c.keys) courseKeys.set(k, [...(courseKeys.get(k) ?? []), c.id]);
  const coursesOf = (s: string) => courseKeys.get(key(s));
  const kindOf = (s: string): KindId | undefined => v.kinds[s] ?? v.kinds[singular(s)];
  const plain = (x: Tok | undefined): x is Tok => !!x && !x.quoted && !x.syntax;
  // A series with a number that's also a course's ("hw 70"): only if there's one so numbered.
  const numbered = (name: string, n: Tok) =>
    !coursesOf(n.low) || [...v.series].some(([s, ns]) => ns.has(n.num!) && sameSeries(name, s, v.abbreviations));
  const twoWords = (a: string, b: string) =>
    v.series.has(`${a} ${b}`) || Object.values(v.abbreviations).some((xs) => xs.includes(`${a} ${b}`));
  const dues: Tok[] = [];

  for (let i = 0; i < ts.length; ) {
    const t = ts[i];
    const next = ts[i + 1];
    const third = ts[i + 2];
    const said = (n: number) => ({ spans: [span(...ts.slice(i, i + n))], text: query.slice(t.start, ts[i + n - 1].end) });
    const push = (part: Part, take: number) => {
      parts.push(part);
      i += take;
    };

    if (t.syntax) {
      const text = query.slice(t.start, t.end);
      const spans = [span(t)];
      const status = STATUS_ZH[t.low] ?? STATUS_EN.find(([ws]) => ws.join(" ") === t.low || ws.join("") === t.low)?.[1];
      if (!t.low) i++; // (still being typed)
      else if (t.syntax === "in") {
        const loose = v.courses.filter((c) => c.keys.some((k) => k.startsWith(key(t.low)))).map((c) => c.id);
        push({ role: "course", courses: coursesOf(t.low) ?? loose, spans, text }, 1);
      } else if (t.syntax === "kind" && kindOf(t.low)) push({ role: "kind", kind: kindOf(t.low)!, spans, text }, 1);
      else if (t.syntax === "is" && status) push({ role: "status", status, spans, text }, 1);
      else if (t.syntax === "due" || t.syntax === "date") {
        const got = time(tokens(t.low, v), 0, now, true);
        const due = t.syntax === "due";
        push({ role: "when", when: got ? { ...got.when, due } : { from: now, to: Infinity, due, label: { later: true } }, spans, text }, 1);
      } else push({ role: "word", quoted: true, spans, text: t.low }, 1);
      continue;
    }
    if (t.quoted) {
      push({ role: "word", quoted: true, spans: [span(t)], text: t.low }, 1);
      continue;
    }

    // Where you are with it.
    const st = STATUS_EN.find(([ws]) => ws.every((w, k) => plain(ts[i + k]) && ts[i + k].low === w));
    if (st) {
      push({ role: "status", status: st[1], ...said(st[0].length) }, st[0].length);
      continue;
    }
    if (t.cjk && STATUS_ZH[t.low]) {
      push({ role: "status", status: STATUS_ZH[t.low], ...said(1) }, 1);
      continue;
    }

    // When; "due" goes with it (or, alone, says: not due yet).
    if (isDue(t)) {
      dues.push(t);
      i++;
      continue;
    }
    const got = time(ts, i, now, isDue(ts[i - 1]));
    if (got) {
      push({ role: "when", when: got.when, ...said(got.take) }, got.take);
      continue;
    }

    // A course, as one word or two ("cs70", "math 53", "53").
    if (plain(next) && !t.cjk && !next.cjk && next.start > t.end && coursesOf(t.low + next.low)) {
      push({ role: "course", courses: coursesOf(t.low + next.low)!, ...said(2) }, 2);
      continue;
    }
    if (!t.nth && coursesOf(t.low)) {
      push({ role: "course", courses: coursesOf(t.low)!, ...said(1) }, 1);
      continue;
    }

    // One of a series: hw3, hw 3, homework #3, problem set 3, 2nd midterm; 第三次作业, 第3讲, 作业3.
    if (!t.cjk) {
      const m = t.low.match(/^(\p{Ll}[\p{Ll}'’]*?)[#._-]?0*(\d{1,4})[a-z]?$/u);
      if (m && m[1].length >= 2) {
        push({ role: "series", name: m[1], n: Number(m[2]), ...said(1) }, 1);
        continue;
      }
      if (wordish(t.low) && plain(next) && next.num !== undefined && !next.nth && numbered(t.low, next)) {
        push({ role: "series", name: t.low, n: next.num, ...said(2) }, 2);
        continue;
      }
      if (wordish(t.low) && plain(next) && wordish(next.low) && plain(third) && third.num !== undefined && twoWords(t.low, next.low) &&
        numbered(`${t.low} ${next.low}`, third)) {
        push({ role: "series", name: `${t.low} ${next.low}`, n: third.num, ...said(3) }, 3);
        continue;
      }
      const nth = ORDINALS[t.low] ?? Number(t.low.match(/^(\d{1,2})(st|nd|rd|th)$/)?.[1] ?? NaN);
      if (nth > 0 && plain(next) && wordish(next.low) && !next.cjk) {
        push({ role: "series", name: next.low, n: nth, ...said(2) }, 2);
        continue;
      }
    } else if (t.nth && t.num !== undefined) {
      const k = ["次", "个"].includes(ts[i + 1]?.low ?? "") ? i + 2 : i + 1; // i18n-ignore
      const what = ts[k];
      if (what?.cjk && what.num === undefined && !STOP_ZH.has(what.low) && TIME_ZH[what.low] === undefined) {
        push({ role: "series", name: what.low, n: t.num, spans: [span(...ts.slice(i, k + 1))], text: query.slice(t.start, what.end) }, k + 1 - i);
        continue;
      }
    } else if (t.num === undefined && !UNITS_ZH.includes(t.low) && !STOP_ZH.has(t.low) && plain(next) && next.num !== undefined && !next.nth &&
      numbered(t.low, next)) {
      push({ role: "series", name: t.low, n: next.num, ...said(2) }, 2);
      continue;
    }

    // A kind of thing; or just a word.
    if (STOP_ZH.has(t.low)) i++;
    else if (kindOf(t.low)) push({ role: "kind", kind: kindOf(t.low)!, ...said(1) }, 1);
    else push({ role: "word", quoted: false, ...said(1) }, 1);
  }

  // "due" with a time: when it's due. Alone (last, or with nothing else to find by): not due yet.
  for (const d of dues) {
    const when = parts.find((p): p is PartOf<"when"> => p.role === "when");
    if (when) {
      when.when = { ...when.when, due: true };
      when.spans = [...when.spans, span(d)].sort((a, b) => a[0] - b[0]);
    } else if (d === ts[ts.length - 1] || !parts.some((p) => p.role === "word" || p.role === "series")) {
      parts.push({ role: "when", when: { from: now, to: Infinity, due: true, label: { later: true } }, spans: [span(d)], text: query.slice(d.start, d.end) });
    } else {
      parts.push({ role: "word", quoted: false, spans: [span(d)], text: d.low });
    }
  }
  parts.sort((a, b) => a.spans[0][0] - b.spans[0][0]);
  return { query, parts };
}

/** Words that say little by themselves ("can I get an extension": extension), left out of what
 * has to match when a query has others. (As search.py has them.) */
export const STOPWORDS = new Set(`a an the and or but if of to in on at by for with from about as into than then so
is are was were be been being am do does did done can could will would should shall must might get
i me my we us our you your he him his she her it its they them their
this that these those there here what which who whom whose when where why how`.split(/\s+/));

/** Whether a part is a word that says little by itself (see STOPWORDS). */
export const little = (p: Part) => p.role === "word" && !p.quoted && STOPWORDS.has(p.text.toLowerCase());

// -- what to do with a reading -----------------------------------------------------------------

/** What the index is asked for a reading: the words (a series as its name and number, which the
 * index knows the other names of), and what it's narrowed to (a kind it has things of: CS 70's
 * announcements that say "midterm"; other kinds stay words, "notes" being a word too). null:
 * there's nothing to find in the text (only a course, a kind, a time, a status). */
export function indexQuery(r: Reading, abbr: Record<string, string[]>): IndexQuery | null {
  const kinds = [...new Set(r.parts.flatMap((p) => (p.role === "kind" && INDEXED.includes(p.kind) ? [p.kind as IndexedKind] : [])))];
  // Little words only when there's nothing else: "what is due this week" is about what's due.
  const parts = r.parts.some((p) => !little(p)) ? r.parts.filter((p) => !little(p)) : r.parts;
  const words = parts.flatMap((p) => {
    if (p.role === "word") return [p.quoted ? `"${p.text.replace(/"/g, "")}"` : p.text];
    if (p.role === "kind") return INDEXED.includes(p.kind) ? [] : [p.text];
    if (p.role !== "series") return [];
    if (!p.name.includes(" ")) return [`${p.name}${p.n}`];
    const short = Object.entries(abbr).find(([k, xs]) => !k.includes(" ") && !CJK.test(k) && xs.includes(p.name))?.[0];
    return [short ? `${short}${p.n}` : `"${p.name} ${p.n}"`];
  });
  if (!words.length) return null;
  const courses = [...new Set(r.parts.flatMap((p) => (p.role === "course" ? p.courses : [])))];
  const when = r.parts.find((p): p is PartOf<"when"> => p.role === "when")?.when;
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    q: words.join(" "),
    courses,
    ...(kinds.length ? { kinds } : {}),
    ...(when && Number.isFinite(when.from) ? { since: iso(when.from) } : {}),
    ...(when && Number.isFinite(when.to) ? { until: iso(when.to) } : {}),
  };
}
const INDEXED: KindId[] = ["announcement", "assignment", "page", "file"]; // (what the index has)
type IndexedKind = "announcement" | "assignment" | "page" | "file";
export interface IndexQuery { q: string; courses: number[]; kinds?: IndexedKind[]; since?: string; until?: string }

/** The reading with misspelled words taken for those meant (`fixes`, from the index: "midtrem":
 * midterm). Not words in quotes: those are as they are. */
export function corrected(r: Reading, fixes: Record<string, string>): Reading {
  const fixOf = (p: Part) => (p.role === "word" && !p.quoted ? fixes[p.text.toLowerCase()] : p.role === "series" ? fixes[p.name] : undefined);
  if (!r.parts.some(fixOf)) return r;
  const parts = r.parts.map((p): Part => {
    const fix = fixOf(p);
    if (!fix) return p;
    if (p.role === "series") return { ...p, name: fix, text: p.text.replace(new RegExp(p.name, "i"), fix), was: p.text };
    return p.role === "word" ? { ...p, text: fix, was: p.text } : p;
  });
  return { ...r, parts };
}

/** The query without what `part` says. */
export function without(query: string, part: Part): string {
  let out = query;
  for (const [a, b] of [...part.spans].sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return out.replace(/\s{2,}/g, " ").trim();
}

/** The query with what `part` says taken only as text (in quotes). */
export function asText(query: string, part: Part): string {
  let out = query;
  for (const [a, b] of [...part.spans].sort((x, y) => y[0] - x[0])) out = `${out.slice(0, a)}"${out.slice(a, b).replace(/"/g, "")}"${out.slice(b)}`;
  return out;
}
