// What search finds for what you type (find.ts), on a small catalog of three courses.
import { describe, expect, it } from "vitest";
import type { CatalogEntry, Hit, Usage } from "./api";
import { type Action, type Describe, type Found, dueSoon, find, prepare, recent, spaced } from "./find";
import { type Thing, thingKey } from "./things";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 864e5).toISOString();

function entry(thing: Thing, fields: Partial<CatalogEntry> = {}): CatalogEntry {
  return { ...thing, name: null, title: "", aliases: [], in_course: "course" in thing ? thing.course : null, ...fields } as CatalogEntry;
}
const course = (id: number, code: string, term: string, aliases: string[]) =>
  entry({ type: "course", course: id }, { name: code, term, aliases });
const file = (path: string, in_course: number, fields: Partial<CatalogEntry> = {}) =>
  entry({ type: "file", path }, { name: path.split("/").pop()!, in_course, ...fields });

const CS70 = "Fall 2026/CS 70/Files";
const things: CatalogEntry[] = [
  course(70, "CS 70", "Fall 2026", ["Discrete Mathematics", "cs70", "cs", "70"]),
  course(170, "CS 170", "Fall 2026", ["Efficient Algorithms", "cs170", "cs", "170"]),
  course(221, "MATH 221", "Spring 2026", ["Linear Algebra", "math221", "math", "221"]),
  course(100, "NEU 100A", "Fall 2026", ["Cellular and Molecular Neurobiology", "neu", "100a", "neu100a"]),
  entry({ type: "view", course: 70, view: "grades" }),
  entry({ type: "view", course: 221, view: "grades" }),
  entry({ type: "view", course: 70, view: "assignments" }),
  entry({ type: "doc", course: 70, kind: "assignment", id: "3" }, { name: "Homework 3", due: day(3), date: day(3), status: "unsubmitted" }),
  entry({ type: "doc", course: 70, kind: "assignment", id: "2" }, { name: "Homework 2", due: day(1), date: day(1), status: "submitted" }),
  entry({ type: "doc", course: 221, kind: "announcement", id: "7" }, { name: "Midterm room", date: day(-2) }),
  entry({ type: "doc", course: 70, kind: "announcement", id: "9" }, { name: "Asynchronous lecture", date: day(-1) }),
  file(`${CS70}/HW3_solutions.pdf`, 70),
  file(`${CS70}/Lectures/lec-02.pdf`, 70),
  file(`${CS70}/Lectures/lec-03.pdf`, 70),
  entry({ type: "folder", path: `${CS70}/Lectures` }, { name: "Lectures", in_course: 70 }),
  file("Spring 2026/MATH 221/Files/math_notes.pdf", 221),
  entry({ type: "link", url: "https://www.eecs70.org" }, { title: "Course website", in_course: 70 }),
];

const VIEWS: Record<string, string[]> = { grades: ["成绩", "Grades"], assignments: ["作业", "Assignments"] }; // i18n-ignore
const describeEntry: Describe = (e) => ({
  names: [e.title, e.name ?? "", ...(e.type === "view" ? VIEWS[e.view]?.slice(1) ?? [] : [])],
  aliases: [...e.aliases, ...(e.type === "view" ? VIEWS[e.view] ?? [] : [])],
  kind: [e.type === "doc" ? e.kind : e.type],
});
const catalog = prepare(things, describeEntry);
const none: Usage = { opened: {}, picks: [] };
const keyOf = (f: Found | null) => f?.key ?? null;
const named = (f: Found) => (f.type === "thing" ? f.entry.title || f.entry.name : f.type === "hit" ? f.hit.title : f.action.id);
const group = (r: ReturnType<typeof find>, id: string) => r.groups.find((g) => g.id === id)?.items.map(named) ?? [];
const all = (r: ReturnType<typeof find>) => [...(r.top ? [r.top] : []), ...r.groups.flatMap((g) => g.items)].map(named);
const run = (q: string, usage = none, hits: Hit[] = [], actions: Action[] = []) => find(q, catalog, usage, hits, actions, NOW);

function hit(fields: Partial<Hit>): Hit {
  return { kind: "file", course_id: 70, course: "CS 70", title: "", path: null, url: null, date: null, snippet: [], match: "name", doc_id: null, ...fields };
}

describe("finding things by name", () => {
  it("finds a course by its code as people type it, before what's in it", () => {
    const r = run("cs70");
    expect(keyOf(r.top)).toBe("course:70");
    expect(group(r, "files")).toEqual([]); // (its files aren't named cs70)
    expect(group(r, "courses")).toEqual([]); // CS 170 isn't CS 70
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
    expect(keyOf(run("hw3").top)).toBe(`file:${CS70}/HW3_solutions.pdf`);
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
