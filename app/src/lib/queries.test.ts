// What should come first for what students type: the queries search is tuned by. A catalog of a
// term's courses (and two earlier ones), with things named the way courses name them; each query
// says what comes first (or what's found, or isn't). Changing a weight in find.ts: run these.
import { describe, expect, it } from "vitest";
import type { CatalogEntry, SubmissionStatus, Usage } from "./api";
import { type Action, type Describe, type Found, find, prepare, vocabulary } from "./find";
import { type KindId, read } from "./query";
import type { Thing, ViewName } from "./things";

const NOW = Date.parse("2026-10-17T19:00:00Z"); // Saturday noon in California
const day = (n: number) => new Date(NOW + n * 864e5).toISOString();

const EE = 1, NEU = 2, M53 = 3, M53D = 4, PHYS = 5, NEU198 = 6, CS61A = 7, M54 = 8;
const DIR: Record<number, string> = {
  [EE]: "Fall 2026/EE 16A", [NEU]: "Fall 2026/NEU 100A", [M53]: "Fall 2026/M53-lec", [M53D]: "Fall 2026/M53-dis",
  [PHYS]: "Fall 2026/PHYS 7B", [NEU198]: "Fall 2026/NEU 198", [CS61A]: "Fall 2025/CS 61A", [M54]: "Spring 2026/MATH 54",
};

function entry(thing: Thing, course: number | null, fields: Partial<CatalogEntry> = {}): CatalogEntry {
  return { ...thing, name: null, title: "", aliases: [], in_course: course, ...fields } as CatalogEntry;
}
const course = (id: number, name: string, term: string, aliases: string[], keys: string[]) =>
  entry({ type: "course", course: id }, id, { name, term, aliases, keys });
const views = (c: number, ...vs: ViewName[]) => vs.map((v) => entry({ type: "view", course: c, view: v }, c));
let ids = 0;
const doc = (c: number, kind: "announcement" | "assignment" | "page" | "post", name: string, fields: Partial<CatalogEntry>) =>
  entry({ type: "doc", course: c, kind, id: String(++ids) }, c, { name, ...fields });
const ann = (c: number, name: string, ago: number) => doc(c, "announcement", name, { date: day(-ago) });
const hw = (c: number, name: string, due: number, status: SubmissionStatus) => doc(c, "assignment", name, { due: day(due), date: day(due), status });
const page = (c: number, name: string, ago: number) => doc(c, "page", name, { date: day(-ago) });
const files = (c: number, ...paths: string[]) => paths.map((p) => entry({ type: "file", path: `${DIR[c]}/${p}` }, c, { name: p.split("/").pop()! }));
const folder = (c: number, path: string) => entry({ type: "folder", path: `${DIR[c]}/${path}` }, c, { name: path.split("/").pop()! });

const things: CatalogEntry[] = [
  course(EE, "EE 16A", "Fall 2026", ["ELENG 16A-LEC-001", "Foundations of Signals, Dynamical Systems, and Information Processing"], ["16a", "ee16a", "eleng16a"]),
  course(NEU, "NEU 100A", "Fall 2026", ["NEU 100A-LEC-001", "Cellular and Molecular Neurobiology"], ["100a", "neu100a"]),
  course(M53, "M53-lec", "Fall 2026", ["MATH 53-LEC-002", "Multivariable Calculus"], ["53", "m53lec", "math53"]),
  course(M53D, "M53-dis", "Fall 2026", ["MATH 53-DIS-205", "Multivariable Calculus"], ["53", "m53dis", "math53"]),
  course(PHYS, "PHYS 7B", "Fall 2026", ["PHYSICS 7B-LEC-001", "Physics for Scientists and Engineers"], ["7b", "phys7b", "physics7b"]),
  course(NEU198, "NEU 198", "Fall 2026", ["Introduction to Neurotechnology"], ["198", "neu198"]),
  course(CS61A, "CS 61A", "Fall 2025", ["Structure and Interpretation of Computer Programs"], ["61a", "cs61a"]),
  course(M54, "MATH 54", "Spring 2026", ["MATH 54-LEC-002", "Linear Algebra and Differential Equations"], ["54", "math54"]),

  ...views(EE, "overview", "announcements", "discussion", "assignments", "grades", "files", "syllabus"),
  // On Ed (what's pinned and staff's posts are in the catalog; the questions are the index's).
  doc(EE, "post", "HW 4 megathread", { date: day(-12), source: "ed" }), doc(EE, "post", "Lab 2 Clarification", { date: day(-5), source: "ed" }),
  doc(EE, "announcement", "Lab Extensions", { date: day(-4), source: "ed" }),
  ann(EE, "HW3 Released", 20), ann(EE, "HW4 Released", 12), ann(EE, "Midterm 1 Logistics", 6), ann(EE, "Prelab 3 Released", 1),
  ...files(EE, "Files/HW/EE16A_FA26_HW3.pdf", "Files/HW/EE16A_FA26_HW3_Sol.pdf", "Files/HW/EE16A_FA26_HW4.pdf",
    "Files/Lectures/EE16A FA26 Lecture9.pdf", "Files/Lectures/EE16A FA26 Lecture10.pdf", "Files/Labs/EE16A_FA26_Lab2.pdf",
    "Files/Labs/EE16A_FA26_PreLab3.pdf", "Files/Exams/FA25 MT1 with Solns.pdf", "Files/Exams/EE16A_FA26_MT1_review.pdf"),
  folder(EE, "Files/HW"), folder(EE, "Files/Lectures"), folder(EE, "Files/Labs"), folder(EE, "Files/Exams"),
  entry({ type: "tool", course: EE, tool: 11 }, EE, { name: "Ed Discussion" }),
  entry({ type: "link", url: "https://www.gradescope.com/courses/123" }, EE, { title: "Gradescope" }),

  ...views(NEU, "overview", "announcements", "assignments", "grades"),
  hw(NEU, "Midterm 1", -10, "graded"), hw(NEU, "Midterm 2", 20, "unsubmitted"), hw(NEU, "Final Exam", 50, "unsubmitted"),
  hw(NEU, "Course Capture - Monday September 28", -18, "unsubmitted"),
  ann(NEU, "Midterm I Regrades + DSP Scheduling", 3), ann(NEU, "Midterm 2 room", 1),
  ...files(NEU, "Files/Worksheets/NEU100A-Worksheet-05.pdf", "Files/Worksheets/NEU100A-Worksheet-05-Answers.pdf",
    "Files/Worksheets/Week 7_Worksheet.pdf", "Files/Exams/Midterm 2 Practice Exam.docx"),
  entry({ type: "note", course: NEU, id: "n1" }, NEU, { text: "Exam: chapters 1-4" }),

  entry({ type: "module", course: M53, module: 4 }, M53, { name: "Solutions to HW3" }),
  entry({ type: "module", course: M53, module: 5 }, M53, { name: "Solutions to HW4" }),
  ...files(M53, "Modules/04 Solutions to HW3/sol-12-1.pdf", "Files/hw-2026.html", "Files/midterm-solutions.pdf"),
  ...views(M53, "grades"),
  ...files(M53D, "Files/derivatives.pdf"),
  ...views(M53D, "grades"),

  page(PHYS, "Sets of Problems", 2),
  ...files(PHYS, "Files/Physics_7B_ProblemSet 4.pdf", "Files/Section 101B/Worksheet 5.pdf", "Files/Section 101B/Worksheet 5 Sol.pdf", "Files/Midterm stats.pdf"),
  ...views(PHYS, "syllabus"),

  hw(NEU198, "HW 1: MoodHat Exploration", -40, "graded"), hw(NEU198, "HW2: Neurotech for Sensory Restoration", -18, "unsubmitted"),
  hw(NEU198, "HW 3: Final Project Brainstorm + Sign-ups", -4, "submitted"),
  hw(NEU198, "HW 4: EEG Classification with Machine Learning", 6, "unsubmitted"),
  ann(NEU198, "HW4 Published + Extension", 1),
  ...views(NEU198, "syllabus"),

  page(CS61A, "Lecture 9 - Recursion", 395), hw(CS61A, "HW 03", -380, "graded"),
  ...views(CS61A, "syllabus"),

  ann(M54, "Midterm 2 grades", 200),
  ...files(M54, "Files/Midterm 2 review materials/practice-MT2-sol.pdf", "Files/Lecture_2_9.pdf"),

  entry({ type: "search", query: "mt", courses: [], kinds: [], content: false }, null, { title: "Midterms" }),
];

// As the app has it (Found.tsx): names as shown, other names, kind words.
const VIEW: Record<ViewName, string[]> = {
  overview: ["Overview", "概览"], modules: ["Modules", "模块"], announcements: ["Announcements", "公告"], // i18n-ignore
  discussion: ["Discussion", "讨论", "Post", "帖子"], // i18n-ignore
  assignments: ["Assignments", "作业"], grades: ["Grades", "成绩"], files: ["Files", "文件"], syllabus: ["Syllabus", "大纲"], // i18n-ignore
  pages: ["Pages", "页面"], tools: ["Tools and links", "工具与链接"], canvas: ["Open in Canvas"], // i18n-ignore
};
const NAME: Record<number, string> = Object.fromEntries(things.flatMap((e) => (e.type === "course" ? [[e.course, e.name ?? ""]] : [])));
const describe_: Describe = (e) => ({
  names: [e.title || (e.type === "view" ? VIEW[e.view][0] : e.type === "file" || e.type === "folder" ? e.path.split("/").pop()! : e.type === "note" ? "Notes" : e.name ?? ""), e.name ?? ""],
  aliases: [...e.aliases, ...(e.type === "view" ? VIEW[e.view] : []), ...(e.type === "note" && e.text ? [e.text] : []),
    ...(e.type === "link" ? [e.url.replace(/^https?:\/\/(www\.)?/, "")] : []), ...(e.type === "search" ? [e.query] : [])],
  kind: [e.type === "doc" ? e.kind : e.type],
});
// The index's abbreviations (search.py's DEFAULT_ABBREVIATIONS), which /catalog sends.
const ABBR: Record<string, string[]> = {
  mt: ["midterm", "mid term", "prelim"], hw: ["homework", "problem set", "pset", "assignment"], ps: ["problem set", "pset", "homework"],
  pset: ["problem set", "homework"], lec: ["lecture", "slides"], disc: ["discussion", "recitation", "section"], rec: ["recitation", "discussion"],
  sol: ["solution", "answer key", "answers"], soln: ["solution", "answer key", "answers"], ans: ["answer", "solution"], syl: ["syllabus"],
  proj: ["project"], qz: ["quiz"], rev: ["review"], oh: ["office hours"], ann: ["announcement"],
  期中: ["midterm", "mt", "prelim"], 期末: ["final"], 考试: ["exam", "midterm", "final"], 作业: ["homework", "assignment", "problem set"], // i18n-ignore
  课件: ["lecture", "slides"], 讲义: ["lecture", "notes"], 答案: ["solution", "answer"], 大纲: ["syllabus"], 讲: ["lecture"], 实验: ["lab"], // i18n-ignore
  测验: ["quiz"], 讨论: ["discussion", "section"], 公告: ["announcement"], 页面: ["page"], 文件: ["file"], // i18n-ignore
};
const KINDS: Record<string, KindId> = {
  公告: "announcement", announcement: "announcement", 作业: "assignment", assignment: "assignment", 页面: "page", page: "page", // i18n-ignore
  模块: "module", module: "module", 文件: "file", file: "file", 文件夹: "folder", folder: "folder", 课程: "course", course: "course", // i18n-ignore
  链接: "link", link: "link", 备忘录: "note", note: "note", tool: "tool", 帖子: "post", post: "post", 讨论: "post", discussion: "post", // i18n-ignore
};
const catalog = prepare(things, describe_, ABBR);
const vocab = vocabulary(catalog, KINDS);
const none: Usage = { opened: {}, picks: [] };
const actions: Action[] = [
  { id: "sync", label: "Sync all courses", names: ["Sync all courses", "Sync", "同步"] }, // i18n-ignore
  ...[EE, NEU].map((c) => ({ id: `sync:${c}`, label: `Sync ${NAME[c]}`, names: ["Sync", "同步"], course: c })), // i18n-ignore
];

const named = (f: Found) => (f.type === "thing" ? f.entry.title || f.entry.name || (f.entry.type === "view" ? `${NAME[f.entry.course]} ${f.entry.view}` : f.entry.type === "note" ? f.entry.text : "") : f.type === "action" ? f.action.id : f.hit.title);
const courseOf = (f: Found | undefined) => (f?.type === "thing" ? f.entry.in_course : null);
function search(q: string, here: number | null = null) {
  const r = find(read(q, vocab, NOW), catalog, none, [], actions, NOW, here);
  const all = [...(r.top ? [r.top] : []), ...r.groups.flatMap((g) => g.items)];
  return { top: r.top ? named(r.top) : null, all: all.map(named), found: all, groups: r.groups };
}

describe("one of a series", () => {
  it("hw4: the assignment that's due, before files and announcements about it", () => {
    expect(search("hw4").top).toBe("HW 4: EEG Classification with Machine Learning");
  });
  it("ee16a hw3: that course's, all of it, not hw 4", () => {
    const r = search("ee16a hw3");
    expect(r.all).toEqual(expect.arrayContaining(["EE16A_FA26_HW3.pdf", "EE16A_FA26_HW3_Sol.pdf", "HW3 Released"]));
    expect(r.found.every((f) => courseOf(f) === EE)).toBe(true);
    expect(r.all).not.toContain("EE16A_FA26_HW4.pdf");
  });
  it("53 hw3: MATH 53's, whichever section", () => {
    const r = search("53 hw3");
    expect(r.top).toBe("Solutions to HW3");
    expect(r.found.every((f) => courseOf(f) === M53 || courseOf(f) === M53D)).toBe(true);
  });
  it("hw3 sol: the solutions", () => {
    expect(search("hw3 sol").all.slice(0, 2).sort()).toEqual(["EE16A_FA26_HW3_Sol.pdf", "Solutions to HW3"]);
  });
  it("ps 4: the problem set, as the course calls it", () => {
    expect(search("ps 4").top).toBe("Physics_7B_ProblemSet 4.pdf");
  });
  it("ws5: worksheets, though nothing says ws is a worksheet", () => {
    expect(search("ws5").all).toEqual(expect.arrayContaining(["Worksheet 5.pdf", "Worksheet 5 Sol.pdf", "NEU100A-Worksheet-05.pdf"]));
  });
  it("mt2: this term's midterm 2 before last term's", () => {
    const r = search("mt2");
    expect(courseOf(r.found[0])).toBe(NEU);
    expect(r.all.indexOf("Midterm 2 grades")).toBeGreaterThan(r.all.indexOf("Midterm 2"));
  });
  it("第二次期中: the second midterm, in Chinese", () => { // i18n-ignore
    const r = search("第二次期中"); // i18n-ignore
    expect(courseOf(r.found[0])).toBe(NEU);
    expect(r.top).toMatch(/^Midterm 2/);
  });
  it("midterm 1: also Midterm I", () => {
    expect(search("midterm 1").all).toEqual(expect.arrayContaining(["Midterm I Regrades + DSP Scheduling", "Midterm 1", "Midterm 1 Logistics"]));
    expect(search("1st midterm").all).toEqual(expect.arrayContaining(["Midterm 1", "Midterm 1 Logistics"]));
  });
  it("lecture 9: this term's, then last year's", () => {
    const r = search("lecture 9");
    expect(r.top).toBe("EE16A FA26 Lecture9.pdf");
    expect(r.all).toContain("Lecture 9 - Recursion");
    expect(r.all).not.toContain("EE16A FA26 Lecture10.pdf");
    expect(search("cs61a lecture 9").top).toBe("Lecture 9 - Recursion");
  });
  it("lab 2, prelab 3: not each other", () => {
    expect(search("lab 2").top).toBe("EE16A_FA26_Lab2.pdf");
    expect(search("prelab 3").all).toEqual(expect.arrayContaining(["Prelab 3 Released", "EE16A_FA26_PreLab3.pdf"]));
    expect(search("prelab 3").all).not.toContain("EE16A_FA26_Lab2.pdf");
  });
  it("hw 13: nothing (not hw 1, not hw 3)", () => {
    expect(search("hw 13").all).toEqual([]);
  });
});

describe("by name", () => {
  it("53 grades: MATH 53's grades", () => {
    expect(search("53 grades").top).toBe("M53-lec grades");
  });
  it("syllabus: this term's courses' first", () => {
    const r = search("syllabus").all;
    expect(r.slice(0, 3).sort()).toEqual(["EE 16A syllabus", "NEU 198 syllabus", "PHYS 7B syllabus"]);
    expect(r.indexOf("CS 61A syllabus")).toBeGreaterThan(r.indexOf("PHYS 7B syllabus"));
  });
  it("gradescope, chapters: a link by its name, a note by what it says", () => {
    expect(search("gradescope").top).toBe("Gradescope");
    expect(search("chapters").top).toBe("Exam: chapters 1-4");
  });
  it("midterms: the smart folder called that, first", () => {
    expect(search("midterms").top).toBe("Midterms");
  });
  it("worksheet: every worksheet", () => {
    expect(search("worksheet").all).toEqual(expect.arrayContaining(["Worksheet 5.pdf", "NEU100A-Worksheet-05.pdf", "Week 7_Worksheet.pdf"]));
  });
  it("ee16a lectures: the folder, and the lectures in it", () => {
    const r = search("ee16a lectures");
    expect(r.top).toBe("Lectures");
    expect(r.all).toEqual(expect.arrayContaining(["EE16A FA26 Lecture9.pdf", "EE16A FA26 Lecture10.pdf"]));
  });
  it("in:phys7b sets: in that course", () => {
    expect(search("in:phys7b sets").top).toBe("Sets of Problems");
  });
  it("sync ee16a: the thing to do", () => {
    expect(search("sync ee16a").top).toBe("sync:1");
  });
});

describe("on Ed", () => {
  it("ee16a hw4: the megathread too, after the homework itself", () => {
    const { all } = search("ee16a hw4");
    expect(all).toContain("HW 4 megathread");
    expect(all.indexOf("HW 4 megathread")).toBeGreaterThan(all.indexOf("EE16A_FA26_HW4.pdf"));
  });
  it("ee16a 帖子: the course's discussion, then its posts", () => { // i18n-ignore
    const r = search("ee16a 帖子"); // i18n-ignore
    expect(r.top).toBe("EE 16A discussion");
    expect(r.all).toEqual(expect.arrayContaining(["Lab 2 Clarification", "HW 4 megathread"]));
  });
  it("lab 2 clarification: the post by its name", () => {
    expect(search("lab 2 clarification").top).toBe("Lab 2 Clarification");
  });
  it("ee16a ed: the course's discussion, then what's from Ed, newest first; nothing else", () => {
    const r = search("ee16a ed");
    expect(r.top).toBe("EE 16A discussion");
    expect(r.all.slice(1)).toEqual(["Lab Extensions", "Lab 2 Clarification", "HW 4 megathread"]);
  });
  it("ed: only what's from Ed, in any course", () => {
    const r = search("ed");
    expect(r.found.every((f) => f.type === "thing" && (f.entry.source === "ed" || f.entry.type === "view"))).toBe(true);
    expect(r.all).toContain("Lab Extensions");
    expect(r.all).not.toContain("Ed Discussion"); // (the tool on Canvas: not what's on Ed)
  });
  it("ed lab 2: what's from Ed, by its name", () => {
    expect(search("ed lab 2").top).toBe("Lab 2 Clarification");
  });
});

describe("narrowed down", () => {
  it("neu100a 公告: its announcements, newest first, after the list of them", () => { // i18n-ignore
    const r = search("neu100a 公告"); // i18n-ignore
    expect(r.top).toBe("NEU 100A announcements");
    expect(r.groups.find((g) => g.id === "announcements")?.items.map(named)).toEqual(["Midterm 2 room", "Midterm I Regrades + DSP Scheduling"]);
  });
  it("未交: what isn't handed in, what's due soonest first", () => { // i18n-ignore
    const r = search("未交"); // i18n-ignore
    expect(r.top).toBe("HW 4: EEG Classification with Machine Learning");
    expect(r.all).toEqual(expect.arrayContaining(["HW2: Neurotech for Sensory Restoration", "Midterm 2", "Final Exam"]));
    expect(r.all).not.toContain("HW 3: Final Project Brainstorm + Sign-ups"); // (handed in)
  });
  it("逾期: past due and not handed in", () => { // i18n-ignore
    expect(search("逾期").all.sort()).toEqual(["Course Capture - Monday September 28", "HW2: Neurotech for Sensory Restoration"]); // i18n-ignore
  });
  it("due this week: what's due this week, asked any way", () => {
    expect(search("due this week").all).toEqual(["HW 3: Final Project Brainstorm + Sign-ups"]);
    expect(search("what is due this week").all).toEqual(["HW 3: Final Project Brainstorm + Sign-ups"]);
  });
  it("the midterm room: little words left out", () => {
    expect(search("where is the midterm 2 room").top).toBe("Midterm 2 room");
  });
  it("neu198 hw: that course's homework, what's due soon first", () => {
    expect(search("neu198 hw").top).toBe("HW 4: EEG Classification with Machine Learning");
  });
});

describe("where you were", () => {
  it("midterm: the course you were last in first", () => {
    expect(courseOf(find(read("midterm", vocab, NOW), catalog, none, [], [], NOW, NEU).top ?? undefined)).toBe(NEU);
    expect(courseOf(find(read("midterm", vocab, NOW), catalog, none, [], [], NOW, EE).top ?? undefined)).toBe(EE);
  });
});
