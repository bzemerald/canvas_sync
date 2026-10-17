// How queries are read (query.ts). Times are local: now is Friday, October 16, 2026, 10 pm.
import { describe, expect, it } from "vitest";
import { type KindId, type Part, type Vocabulary, asText, corrected, indexQuery, read, sameSeries, seriesIn, singular, without } from "./query";

const NOW = new Date(2026, 9, 16, 22, 0).getTime();
const at = (m: number, d: number, y = 2026) => new Date(y, m - 1, d).getTime();
const range = (n: number) => new Set(Array.from({ length: n }, (_, i) => i + 1));

const ABBR: Record<string, string[]> = {
  mt: ["midterm", "mid term", "prelim"], hw: ["homework", "problem set", "pset", "assignment"], ps: ["problem set", "pset", "homework"],
  lec: ["lecture", "slides"], 作业: ["homework", "assignment", "problem set"], 期中: ["midterm", "mt", "prelim"], 讲: ["lecture"], // i18n-ignore
};
const KINDS: Record<string, KindId> = {
  公告: "announcement", announcement: "announcement", 作业: "assignment", assignment: "assignment", 页面: "page", page: "page", // i18n-ignore
  文件: "file", file: "file", 文件夹: "folder", folder: "folder", 课程: "course", course: "course", link: "link", note: "note", // i18n-ignore
};
const vocab: Vocabulary = {
  courses: [
    { id: 70, keys: ["cs70", "compsci70", "70"] },
    { id: 531, keys: ["m53lec", "math53", "53"] },
    { id: 532, keys: ["m53dis", "math53", "53"] },
    { id: 8, keys: ["datac8", "c8", "8", "data8"] },
    { id: 1, keys: ["cogsci1", "1"] },
    { id: 54, keys: ["math54", "54", "线代"] }, // i18n-ignore
  ],
  kinds: KINDS,
  series: new Map([
    ["hw", range(7)], ["homework", range(7)], ["problem set", range(8)], ["set", range(8)], ["lab", range(6)],
    ["midterm", range(2)], ["week", range(15)], ["lecture", range(20)],
  ]),
  abbreviations: ABBR,
};
const parts = (q: string) => read(q, vocab, NOW).parts;
/** The parts, in short: "course:70", "series:hw 3", "when:…", "kind:assignment", "word:sol". */
function short(p: Part): string {
  switch (p.role) {
    case "course": return `course:${p.courses.join(",")}`;
    case "series": return `series:${p.name} ${p.n}`;
    case "kind": return `kind:${p.kind}`;
    case "status": return `status:${p.status}`;
    case "word": return p.quoted ? `"${p.text}"` : `word:${p.text}`;
    case "when": return `when:${new Date(p.when.from).toDateString()}${Number.isFinite(p.when.to) ? `..${new Date(p.when.to).toDateString()}` : ".."}${p.when.due ? " due" : ""}`;
  }
}
const said = (q: string) => parts(q).map(short);
const day = (m: number, d: number, due = false) => `when:${new Date(at(m, d)).toDateString()}..${new Date(at(m, d + 1)).toDateString()}${due ? " due" : ""}`;
const days = (m: number, d: number, m2: number, d2: number, due = false) => `when:${new Date(at(m, d)).toDateString()}..${new Date(at(m2, d2)).toDateString()}${due ? " due" : ""}`;

describe("a course", () => {
  it("is its code or number, in one word or two", () => {
    expect(said("cs70 hw3")).toEqual(["course:70", "series:hw 3"]);
    expect(said("math 53 hw 3")).toEqual(["course:531,532", "series:hw 3"]);
    expect(said("53")).toEqual(["course:531,532"]);
    expect(said("data c8")).toEqual(["course:8"]);
    expect(said("线代 作业")).toEqual(["course:54", "kind:assignment"]); // i18n-ignore
  });

  it("isn't a number that's one of a series", () => {
    expect(said("lab 1")).toEqual(["series:lab 1"]); // (1 is COGSCI 1's too, but there's a lab 1)
    expect(said("hw 70")).toEqual(["word:hw", "course:70"]); // (there's no hw 70)
    expect(said("assignments 70")).toEqual(["kind:assignment", "course:70"]);
  });

  it("isn't a word still being typed", () => {
    expect(said("cs7")).toEqual(["series:cs 7"]);
    expect(said("cs")).toEqual(["word:cs"]);
  });
});

describe("one of a series", () => {
  it("is a name and a number, however it's written", () => {
    expect(said("hw3")).toEqual(["series:hw 3"]);
    expect(said("hw 3")).toEqual(["series:hw 3"]);
    expect(said("homework #3")).toEqual(["series:homework 3"]);
    expect(said("lec-09")).toEqual(["series:lec 9"]);
    expect(said("problem set 3")).toEqual(["series:problem set 3"]);
    expect(said("2nd midterm")).toEqual(["series:midterm 2"]);
    expect(said("second midterm")).toEqual(["series:midterm 2"]);
  });

  it("in Chinese too", () => {
    expect(said("第三次作业")).toEqual(["series:作业 3"]); // i18n-ignore
    expect(said("第3次作业")).toEqual(["series:作业 3"]); // i18n-ignore
    expect(said("作业3")).toEqual(["series:作业 3"]); // i18n-ignore
    expect(said("作业 3")).toEqual(["series:作业 3"]); // i18n-ignore
    expect(said("期中二")).toEqual(["series:期中 2"]); // i18n-ignore
    expect(said("第9讲")).toEqual(["series:讲 9"]); // i18n-ignore
  });

  it("is found in names", () => {
    expect(seriesIn("Homework 3: RISC-V + Logic")).toEqual([{ name: "homework", n: 3 }]);
    expect(seriesIn("EE64_FA26_HW6_Sol.pdf")).toContainEqual({ name: "hw", n: 6 });
    expect(seriesIn("Problem Set #3")).toEqual([{ name: "set", n: 3 }, { name: "problem set", n: 3 }]);
    expect(seriesIn("第3讲 导数.pdf")).toEqual([{ name: "讲", n: 3 }]); // i18n-ignore
    expect(seriesIn("第3次作业")).toEqual([{ name: "作业", n: 3 }]); // i18n-ignore
    expect(seriesIn("作业3")).toEqual([{ name: "作业", n: 3 }]); // i18n-ignore
    expect(seriesIn("Midterm I Regrades")).toEqual([{ name: "midterm", n: 1 }]);
    expect(seriesIn("Topics II")).toEqual([{ name: "topics", n: 2 }]);
    expect(seriesIn("Homework 2: FP + RISC-V")).toEqual([{ name: "homework", n: 2 }]); // (not risc 5)
  });

  it("is the same series by another name", () => {
    expect(sameSeries("hw", "homework", ABBR)).toBe(true);
    expect(sameSeries("hw", "problem set", ABBR)).toBe(true);
    expect(sameSeries("ps", "hw", ABBR)).toBe(true); // (both homework)
    expect(sameSeries("mt", "prelim", ABBR)).toBe(true);
    expect(sameSeries("期中", "midterm", ABBR)).toBe(true); // i18n-ignore
    expect(sameSeries("lec", "lecture", ABBR)).toBe(true);
    expect(sameSeries("labs", "lab", ABBR)).toBe(true);
    expect(sameSeries("ws", "worksheet", ABBR)).toBe(true); // (no abbreviation for it: its letters in order)
    expect(sameSeries("fe", "final exam", ABBR)).toBe(true); // (its initials)
    expect(sameSeries("ps", "physics", ABBR)).toBe(false); // (ps is problem set)
    expect(sameSeries("lab", "lecture", ABBR)).toBe(false);
    expect(sameSeries("midterm", "final", ABBR)).toBe(false);
    expect(singular("quizzes")).toBe("quiz");
    expect(singular("classes")).toBe("class");
    expect(singular("problem sets")).toBe("problem set");
  });
});

describe("a time", () => {
  it("is a day", () => {
    expect(said("today")).toEqual([day(10, 16)]);
    expect(said("tomorrow")).toEqual([day(10, 17)]);
    expect(said("明天")).toEqual([day(10, 17)]); // i18n-ignore
    expect(said("后天")).toEqual([day(10, 18)]); // i18n-ignore
    expect(said("friday")).toEqual([day(10, 16)]); // (it's Friday)
    expect(said("saturday")).toEqual([day(10, 17)]);
    expect(said("next friday")).toEqual([day(10, 23)]);
    expect(said("last friday")).toEqual([day(10, 9)]);
    expect(said("周三")).toEqual([day(10, 14)]); // i18n-ignore
    expect(said("下周三")).toEqual([day(10, 21)]); // i18n-ignore
    expect(said("oct 20")).toEqual([day(10, 20)]);
    expect(said("20 oct")).toEqual([day(10, 20)]);
    expect(said("10/20")).toEqual([day(10, 20)]);
    expect(said("2026-10-20")).toEqual([day(10, 20)]);
    expect(said("10月20日")).toEqual([day(10, 20)]); // i18n-ignore
    expect(said("十月二十号")).toEqual([day(10, 20)]); // i18n-ignore
    expect(said("may 5")).toEqual([day(5, 5)]); // (the nearest May 5)
  });

  it("is a week or a month", () => {
    expect(said("this week")).toEqual([days(10, 12, 10, 19)]);
    expect(said("本周")).toEqual([days(10, 12, 10, 19)]); // i18n-ignore
    expect(said("next week")).toEqual([days(10, 19, 10, 26)]);
    expect(said("上周")).toEqual([days(10, 5, 10, 12)]); // i18n-ignore
    expect(said("this month")).toEqual([days(10, 1, 11, 1)]);
    expect(said("下个月")).toEqual([days(11, 1, 12, 1)]); // i18n-ignore
    expect(said("10月")).toEqual([days(10, 1, 11, 1)]); // i18n-ignore
    expect(said("weekend")).toEqual([days(10, 17, 10, 19)]);
  });

  it("isn't a word that could be something else", () => {
    expect(said("may")).toEqual(["word:may"]);
    expect(said("sat")).toEqual(["word:sat"]);
    expect(said("this")).toEqual(["word:this"]);
  });

  it("is when it's due, said with due", () => {
    expect(said("due tomorrow")).toEqual([day(10, 17, true)]);
    expect(said("due fri")).toEqual([day(10, 16, true)]);
    expect(said("本周截止的作业")).toEqual([days(10, 12, 10, 19, true), "kind:assignment"]); // i18n-ignore
    expect(read("本周截止", vocab, NOW).parts[0].spans).toEqual([[0, 2], [2, 4]]); // i18n-ignore
  });

  it("is not due yet, for due alone", () => {
    expect(said("cs70 due")).toEqual(["course:70", "when:Fri Oct 16 2026.. due"]);
    expect(said("hw due")).toEqual(["word:hw", "when:Fri Oct 16 2026.. due"]);
    expect(said("due dates")).toEqual(["word:due", "word:dates"]); // (a word, followed by others)
  });
});

describe("where you are with it", () => {
  it("in either language", () => {
    expect(said("未交")).toEqual(["status:todo"]); // i18n-ignore
    expect(said("not submitted")).toEqual(["status:todo"]);
    expect(said("missing")).toEqual(["status:missing"]);
    expect(said("past due")).toEqual(["status:overdue"]);
    expect(said("逾期")).toEqual(["status:overdue"]); // i18n-ignore
    expect(said("已交")).toEqual(["status:submitted"]); // i18n-ignore
    expect(said("graded")).toEqual(["status:graded"]);
  });
});

describe("said outright", () => {
  it("in:, kind:, due:, is:, and quotes", () => {
    expect(said("in:cs70 kind:file due:fri is:missing")).toEqual(["course:70", "kind:file", day(10, 16, true), "status:missing"]);
    expect(said('"cs70" "problem set"')).toEqual(['"cs70"', '"problem set"']);
    expect(said("kind:pdf")).toEqual(['"pdf"']); // (not a kind: as text)
    expect(said("in:")).toEqual([]); // (still being typed)
    expect(said("in:m53")).toEqual(["course:531,532"]); // (the start of a course's words)
  });
});

describe("what's done with a reading", () => {
  it("asks the index for the words, in the course, at the time", () => {
    expect(indexQuery(read("cs70 hw3 sol", vocab, NOW), ABBR)).toEqual({ q: "hw3 sol", courses: [70] });
    expect(indexQuery(read("problem set 3", vocab, NOW), ABBR)?.q).toBe("hw3"); // (the index knows hw)
    expect(indexQuery(read("作业 midterm 本周", vocab, NOW), ABBR)).toEqual({ q: "midterm", courses: [], kinds: ["assignment"], since: new Date(at(10, 12)).toISOString().replace(".000", ""), until: new Date(at(10, 19)).toISOString().replace(".000", "") }); // i18n-ignore
    expect(indexQuery(read("lecture notes", { ...vocab, kinds: { ...KINDS, note: "note" } }, NOW), ABBR)?.q).toBe("lecture notes"); // (no notes in the index: a word)
    expect(indexQuery(read("cs70 公告", vocab, NOW), ABBR)).toBeNull(); // i18n-ignore
    expect(indexQuery(read("cs70 本周", vocab, NOW), ABBR)).toBeNull(); // i18n-ignore
  });

  it("takes misspelled words for those meant, as the index says, but not quoted ones", () => {
    const r = corrected(read('midtrem "lectrue" sol', vocab, NOW), { midtrem: "midterm", lectrue: "lecture" });
    expect(r.parts.map((p) => (p.role === "word" ? [p.text, p.was ?? null] : null))).toEqual([["midterm", "midtrem"], ["lectrue", null], ["sol", null]]);
    expect(asText(r.query, r.parts[0])).toBe('"midtrem" "lectrue" sol'); // (searched for as typed)
    const s = corrected(read("lectrue 9", vocab, NOW), { lectrue: "lecture" }).parts[0];
    expect(s.role === "series" && [s.name, s.n, s.text, s.was]).toEqual(["lecture", 9, "lecture 9", "lectrue 9"]);
  });

  it("takes a part back, or as text", () => {
    const r = read("cs70 本周截止的作业", vocab, NOW); // i18n-ignore
    const when = r.parts.find((p) => p.role === "when")!;
    expect(without(r.query, when)).toBe("cs70 的作业"); // i18n-ignore
    expect(asText(r.query, r.parts[0])).toBe('"cs70" 本周截止的作业'); // i18n-ignore
    expect(said(asText(r.query, r.parts[0]))).toEqual(['"cs70"', days(10, 12, 10, 19, true), "kind:assignment"]);
  });
});
