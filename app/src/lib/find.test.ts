// What search finds for what you type (find.ts), on a small catalog of a few courses.
import { describe, expect, it } from "vitest";
import type { CatalogEntry, Hit, Usage } from "./api";
import { type Action, type Describe, type Found, dueSoon, find, prepare, recent, spaced, vocabulary } from "./find";
import { type KindId, key, read } from "./query";
import { type Thing, thingKey } from "./things";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 864e5).toISOString();

function entry(thing: Thing, fields: Partial<CatalogEntry> = {}): CatalogEntry {
  return { ...thing, name: null, title: "", aliases: [], in_course: "course" in thing ? thing.course : null, ...fields } as CatalogEntry;
}
const course = (id: number, code: string, term: string, aliases: string[]) =>
  entry({ type: "course", course: id }, { name: code, term, aliases, keys: [key(code), ...aliases.map(key).filter((k) => /\d/.test(k))] });
const file = (path: string, in_course: number, fields: Partial<CatalogEntry> = {}) =>
  entry({ type: "file", path }, { name: path.split("/").pop()!, in_course, ...fields });
const doc = (course: number, kind: "announcement" | "assignment" | "page", id: string, name: string, fields: Partial<CatalogEntry> = {}) =>
  entry({ type: "doc", course, kind, id }, { name, ...fields });

const CS70 = "Fall 2026/CS 70/Files";
const things: CatalogEntry[] = [
  course(70, "CS 70", "Fall 2026", ["Discrete Mathematics", "cs70", "cs", "70"]),
  course(170, "CS 170", "Fall 2026", ["Efficient Algorithms", "cs170", "cs", "170"]),
  course(221, "MATH 221", "Spring 2026", ["Linear Algebra", "math221", "math", "221"]),
  course(100, "NEU 100A", "Fall 2026", ["Cellular and Molecular Neurobiology", "neu", "100a", "neu100a"]),
  course(7, "PHYS 7A", "Summer 2026", ["Physics", "phys7a", "7a"]),
  entry({ type: "view", course: 70, view: "grades" }),
  entry({ type: "view", course: 221, view: "grades" }),
  entry({ type: "view", course: 70, view: "assignments" }),
  entry({ type: "view", course: 70, view: "announcements" }),
  doc(70, "assignment", "3", "Homework 3", { due: day(3), date: day(3), status: "unsubmitted" }),
  doc(70, "assignment", "2", "Homework 2", { due: day(1), date: day(1), status: "submitted" }),
  doc(221, "announcement", "7", "Midterm room", { date: day(-2) }),
  doc(70, "announcement", "9", "Asynchronous lecture", { date: day(-1) }),
  doc(7, "assignment", "33", "Problem Set 3", { due: day(-60), date: day(-60), status: "graded" }),
  doc(7, "assignment", "34", "Problem Set 4", { due: day(-53), date: day(-53), status: "missing" }),
  file(`${CS70}/HW3_solutions.pdf`, 70),
  file(`${CS70}/Lectures/lec-02.pdf`, 70),
  file(`${CS70}/Lectures/lec-03.pdf`, 70),
  entry({ type: "folder", path: `${CS70}/Lectures` }, { name: "Lectures", in_course: 70 }),
  file("Fall 2026/NEU 100A/Files/Problem Set 3.pdf", 100),
  file("Fall 2026/NEU 100A/Files/Homework 3 notes.pdf", 100),
  file("Spring 2026/MATH 221/Files/math_notes.pdf", 221),
  file("Spring 2026/MATH 221/Files/MT 2.pdf", 221),
  file("Spring 2026/MATH 221/Files/Midterm 2 Practice Exam.docx", 221),
  entry({ type: "link", url: "https://www.eecs70.org" }, { title: "Course website", in_course: 70 }),
];

const VIEWS: Record<string, string[]> = { grades: ["成绩", "Grades"], assignments: ["作业", "Assignments"], announcements: ["公告", "Announcements"] }; // i18n-ignore
const describeEntry: Describe = (e) => ({
  names: [e.title, e.name ?? "", ...(e.type === "view" ? VIEWS[e.view]?.slice(1) ?? [] : [])],
  aliases: [...e.aliases, ...(e.type === "view" ? VIEWS[e.view] ?? [] : [])],
  kind: [e.type === "doc" ? e.kind : e.type],
});
const ABBR: Record<string, string[]> = {
  mt: ["midterm", "mid term", "prelim"], hw: ["homework", "problem set", "pset", "assignment"], ps: ["problem set", "pset", "homework"],
  sol: ["solution", "answer key", "answers"], 作业: ["homework", "assignment", "problem set"], 期中: ["midterm", "mt", "prelim"], // i18n-ignore
};
const KINDS: Record<string, KindId> = { 公告: "announcement", announcement: "announcement", 作业: "assignment", assignment: "assignment", 文件: "file", file: "file" }; // i18n-ignore
const catalog = prepare(things, describeEntry);
const known = prepare(things, describeEntry, ABBR); // (with the abbreviations the index has)
const none: Usage = { opened: {}, picks: [] };
const keyOf = (f: Found | null) => f?.key ?? null;
const named = (f: Found) => (f.type === "thing" ? f.entry.title || f.entry.name : f.type === "hit" ? f.hit.title : f.action.id);
const group = (r: ReturnType<typeof find>, id: string) => r.groups.find((g) => g.id === id)?.items.map(named) ?? [];
const all = (r: ReturnType<typeof find>) => [...(r.top ? [r.top] : []), ...r.groups.flatMap((g) => g.items)].map(named);
const run = (q: string, usage = none, hits: Hit[] = [], actions: Action[] = [], c = catalog) =>
  find(read(q, vocabulary(c, KINDS), NOW), c, usage, hits, actions, NOW);
const ask = (q: string) => run(q, none, [], [], known);

function hit(fields: Partial<Hit>): Hit {
  return { kind: "file", course_id: 70, course: "CS 70", title: "", path: null, url: null, date: null, snippet: [], match: "name", doc_id: null, ...fields };
}

describe("finding things by name", () => {
  it("finds a course by its code as people type it, before what's in it", () => {
    const r = run("cs70");
    expect(keyOf(r.top)).toBe("course:70");
    expect(group(r, "files")).toEqual([]); // (its files aren't named cs70)
    expect(group(r, "courses")).toEqual([]); // CS 170 isn't CS 70
    expect(keyOf(run("cs7").top)).toBe("course:70"); // (on the way)
  });

  it("finds a course's view by the course and the view's name, in either language", () => {
    expect(keyOf(run("cs70 grades").top)).toBe("view:70:grades");
    expect(keyOf(run("221 成绩").top)).toBe("view:221:grades"); // i18n-ignore
  });

  it("puts this term's courses first when names match as well", () => {
    expect(keyOf(run("grades").top)).toBe("view:70:grades");
  });

  it("puts what a thing is shown as before what else it answers to", () => {
    // "c" starts CS 70 as it's shown, and NEU 100A's full name: both this term's.
    expect(keyOf(run("c").top)).toBe("course:70");
    expect(keyOf(run("cellular").top)).toBe("course:100"); // (still found by it)
  });

  it("matches names however they're written: separators, digits, leading zeros", () => {
    expect(spaced("HW3_solutions.pdf")).toBe("HW 3 solutions pdf");
    expect(spaced("lec-02.pdf")).toBe("lec 2 pdf");
    expect(spaced("midtermReview.pdf")).toBe("midterm Review pdf");
    expect(keyOf(run("lec2").top)).toBe(`file:${CS70}/Lectures/lec-02.pdf`);
    expect(group(run("lec2"), "files")).toEqual([]);
  });

  it("doesn't list everything in a course just because the course matches", () => {
    const r = run("math");
    expect(keyOf(r.top)).toBe("course:221");
    expect(group(r, "files")).toEqual(["math_notes.pdf"]);
    expect(group(r, "announcements")).toEqual([]);
  });

  it("puts first what you open most and lately", () => {
    expect(all(run("lec")).slice(0, 2)).toEqual(["lec-02.pdf", "lec-03.pdf"]);
    const usage: Usage = { opened: { [`file:${CS70}/Lectures/lec-03.pdf`]: { count: 6, last: day(-1) } }, picks: [] };
    expect(keyOf(run("lec", usage).top)).toBe(`file:${CS70}/Lectures/lec-03.pdf`);
  });

  it("puts on top what you opened after typing the same (or more of it)", () => {
    const usage: Usage = { opened: {}, picks: [{ query: "lec 3", key: `file:${CS70}/Lectures/lec-03.pdf`, count: 1, last: day(-3) }] };
    expect(keyOf(run("le", usage).top)).toBe(`file:${CS70}/Lectures/lec-03.pdf`);
    expect(keyOf(run("lab", usage).top)).not.toBe(`file:${CS70}/Lectures/lec-03.pdf`); // (only if it matches at all)
    // What "cs70 grades" found comes on top for "cs70", though "cs70" alone doesn't name it.
    const grades: Usage = { opened: {}, picks: [{ query: "cs70 grades", key: "view:70:grades", count: 1, last: day(-1) }] };
    expect(keyOf(run("cs70", grades).top)).toBe("view:70:grades");
  });

  it("finds things to do; those about a course, when the course is named too", () => {
    const actions: Action[] = [
      { id: "sync", label: "Sync all", names: ["Sync all courses", "Sync"] },
      { id: "sync:70", label: "Sync CS 70", names: ["Sync", "同步"], course: 70 }, // i18n-ignore
      { id: "settings", label: "Settings", names: ["Settings"] },
    ];
    const r = run("sync cs70", none, [], actions);
    expect(keyOf(r.top)).toBe("action:sync:70");
    expect(r.groups).toEqual([]);
    expect(all(run("sync", none, [], actions))).toEqual(["sync"]); // (not "Asynchronous lecture": "sync" doesn't start it)
  });
});

describe("one of a series, by any of its names", () => {
  it("finds what's numbered so, not what's numbered otherwise", () => {
    const r = ask("hw3");
    expect(all(r)).toEqual(expect.arrayContaining(["Homework 3", "HW3_solutions.pdf", "Problem Set 3"]));
    expect(all(r)).not.toContain("Homework 2");
    expect(keyOf(r.top)).toBe("doc:70:assignment:3"); // (this term's, due soon)
    expect(keyOf(ask("hw3 sol").top)).toBe(`file:${CS70}/HW3_solutions.pdf`);
    expect(all(ask("homework 3"))).toContain("HW3_solutions.pdf");
  });

  it("by the name typed a little before the series' other names", () => {
    const order = (q: string) => all(ask(q)).filter((n) => n?.startsWith("Problem Set 3.") || n?.startsWith("Homework 3 notes"));
    expect(order("ps 3")).toEqual(["Problem Set 3.pdf", "Homework 3 notes.pdf"]);
    expect(order("hw 3")).toEqual(["Homework 3 notes.pdf", "Problem Set 3.pdf"]);
  });

  it("as it's written in the other names of the series, in either language", () => {
    expect(all(ask("ps 3"))).toEqual(expect.arrayContaining(["Problem Set 3", "Homework 3"]));
    expect(keyOf(ask("第3次作业").top)).toBe("doc:70:assignment:3"); // i18n-ignore
    expect(all(ask("mt2"))).toEqual(expect.arrayContaining(["MT 2.pdf", "Midterm 2 Practice Exam.docx"]));
    expect(all(ask("期中2"))).toEqual(expect.arrayContaining(["MT 2.pdf", "Midterm 2 Practice Exam.docx"])); // i18n-ignore
  });

  it("finds a word's abbreviations and what it abbreviates", () => {
    expect(all(ask("midterm"))).toEqual(expect.arrayContaining(["Midterm room", "MT 2.pdf"]));
    expect(all(ask("cs70 hw"))).toEqual(expect.arrayContaining(["Homework 3", "Homework 2"]));
  });
});

describe("narrowed down", () => {
  it("to a kind of thing: everything of the kind, its list first", () => {
    const r = run("cs70 公告"); // i18n-ignore
    expect(keyOf(r.top)).toBe("view:70:announcements");
    expect(group(r, "announcements")).toEqual(["Asynchronous lecture"]);
    expect(all(run("cs70 公告 async"))).toEqual(["Asynchronous lecture"]); // i18n-ignore
  });

  it("to a time: what's from then, or due then", () => {
    expect(all(run("cs70 this week")).sort()).toEqual(["Asynchronous lecture", "Homework 2"]);
    expect(all(run("due next week"))).toEqual(["Homework 3"]);
    expect(all(run("cs70 due")).sort()).toEqual(["Homework 2", "Homework 3"]); // (not due yet)
  });

  it("to where you are with it", () => {
    expect(all(run("未交"))).toEqual(["Homework 3", "Problem Set 4"]); // i18n-ignore
    expect(all(run("overdue"))).toEqual(["Problem Set 4"]);
    expect(all(run("graded"))).toEqual(["Problem Set 3"]);
    expect(all(run("submitted hw"))).toEqual([]); // (Homework 2 isn't named hw without the abbreviations)
    expect(all(run("submitted homework"))).toEqual(["Homework 2"]);
  });

  it("to a course said outright", () => {
    expect(all(run("in:cs70 lec")).slice(0, 2)).toEqual(["lec-02.pdf", "lec-03.pdf"]);
    expect(all(run("in:math221 lec"))).toEqual([]);
  });
});

describe("with what the index finds", () => {
  it("takes what the index finds by name (it knows hw is homework) into the groups", () => {
    const r = run("cs70 hw", none, [hit({ kind: "assignment", title: "Homework 3", doc_id: "3", url: "/courses/70/assignments/3" })]);
    expect(all(r)).toContain("Homework 3");
    expect(all(r)).not.toContain("Homework 2"); // (the index didn't find it)
  });

  it("lists what's only inside last, once", () => {
    const notes = hit({ course_id: 221, path: "Spring 2026/MATH 221/Files/math_notes.pdf", match: "content", title: "math_notes.pdf" });
    const r = run("lec", none, [notes, hit({ path: `${CS70}/Lectures/lec-02.pdf`, match: "content", title: "lec-02.pdf" })]);
    expect(r.groups.at(-1)?.id).toBe("inside");
    expect(group(r, "inside")).toEqual(["math_notes.pdf"]); // (lec-02 is found by name already)
    const only = run("eigenvalue", none, [notes]);
    expect(keyOf(only.top)).toBe("file:Spring 2026/MATH 221/Files/math_notes.pdf"); // nothing by name: the best inside
  });

  it("keeps what the index has that isn't synced, to open on Canvas", () => {
    const r = run("syllabus", none, [hit({ kind: "file", title: "syllabus.pdf", url: "/courses/70/files/9" })]);
    expect(r.top?.type).toBe("hit");
  });

  it("leaves out what the index finds that the reading narrows away", () => {
    const r = run("graded hw", none, [hit({ kind: "assignment", title: "Homework 3", doc_id: "3", url: "/courses/70/assignments/3" })]);
    expect(all(r)).not.toContain("Homework 3"); // (not graded)
  });
});

describe("before anything is typed", () => {
  it("has what's due this week that you haven't handed in, soonest first", () => {
    expect(dueSoon(catalog, NOW).map(named)).toEqual(["Homework 3"]);
  });

  it("has what you opened lately, latest first", () => {
    const usage: Usage = {
      opened: { "course:221": { count: 1, last: day(-5) }, [thingKey({ type: "view", course: 70, view: "grades" })]: { count: 2, last: day(-1) }, gone: { count: 9, last: day(0) } },
      picks: [],
    };
    expect(recent(catalog, usage).map((f) => f.key)).toEqual(["view:70:grades", "course:221"]);
  });
});
