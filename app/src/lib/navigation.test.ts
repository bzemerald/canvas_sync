// How the main window gets around (navigation.ts): its history, a course's tabs, the tab at the end.
import { describe, expect, it } from "vitest";
import {
  type CourseView, START, type View, firstTab, listed, replaced, settle, showing, showsFiles, spareOf, stepped, toTab, went, withoutSpare,
} from "./navigation";
import { type Shown, type Thing, view } from "./things";

const DIR = "Fall 2026/MATH 221";
const tab = (name: Parameters<typeof view>[1], hidden = false): Shown => ({ ...view(1, name), hidden, own: true });
const page = (id: string): Thing => ({ type: "doc", course: 1, kind: "page", id });
const folder = (path: string): Thing => ({ type: "folder", path });
const at = (t: Thing, more: Partial<CourseView> = {}): CourseView => ({ kind: "course", id: 1, tab: t, path: DIR, ...more });
const TABS = [tab("overview"), tab("modules"), tab("announcements"), tab("assignments"), tab("files"), tab("pages", true)];

describe("the history", () => {
  const a: View = { kind: "browse", path: "a" };
  const b: View = { kind: "browse", path: "b" };

  it("goes on from where it is: what was ahead is dropped", () => {
    const h = went(went(START, a), b);
    expect([h.stack.length, h.i]).toEqual([3, 2]);
    const back = went(stepped(h, -1), { kind: "settings" });
    expect(back.stack.map((v) => v.kind)).toEqual(["browse", "browse", "settings"]);
    expect(back.i).toBe(2);
  });
  it("steps no further than there is", () => {
    const h = went(START, a);
    expect(stepped(h, 1).i).toBe(1);
    expect(stepped(stepped(h, -1), -1).i).toBe(0);
  });
  it("changes where it is without a new entry", () => {
    const h = replaced(went(START, a), b);
    expect([h.stack.length, h.stack[1]]).toEqual([2, b]);
  });
});

describe("going to a tab", () => {
  it("drops what was being read, and what was marked", () => {
    const v = toTab(at(view(1, "announcements"), { item: "7", found: "hw", select: "x" }), view(1, "assignments"), DIR);
    expect(v).toMatchObject({ tab: view(1, "assignments"), item: undefined, found: undefined, select: undefined, blank: false, first: false });
  });
  it("keeps the folder the files tab was in, but starts again from the course's on a second click", () => {
    const deep = at(view(1, "files"), { path: `${DIR}/Files/Week 1` });
    expect(toTab(deep, view(1, "grades"), DIR).path).toBe(`${DIR}/Files/Week 1`);
    expect(toTab(deep, view(1, "files"), DIR).path).toBe(DIR);
  });
  it("is at the folder, for a folder tab; and back at the course's after one", () => {
    const week = folder(`${DIR}/Files/Week 1`);
    expect(toTab(at(view(1, "overview")), week, DIR).path).toBe(`${DIR}/Files/Week 1`);
    expect(toTab(at(week, { path: `${DIR}/Files/Week 1` }), view(1, "files"), DIR).path).toBe(DIR);
  });
  it("from a new tab, clicking the tab before it shows it as it was", () => {
    const v = at(view(1, "files"), { path: `${DIR}/Files`, blank: true });
    expect(toTab(v, view(1, "files"), DIR)).toMatchObject({ blank: false, path: `${DIR}/Files` });
  });
});

describe("the first tab", () => {
  it("is the first one showing that shows something here", () => {
    expect(firstTab(TABS, 1)).toEqual(view(1, "overview"));
    const tool: Shown = { type: "tool", course: 1, tool: 5 };
    expect(firstTab([tab("overview", true), tool, tab("modules")], 1)).toEqual(view(1, "modules"));
  });
  it("is the overview when there's none", () => expect(firstTab([], 1)).toEqual(view(1, "overview")));
});

describe("where a course's page settles, its tabs known", () => {
  it("opens on its first tab, keeping what search marked", () => {
    const tabs = [tab("overview", true), ...TABS.slice(1)];
    expect(settle(at(view(1, "overview"), { first: true, found: "hw" }), tabs, DIR)).toMatchObject({ tab: view(1, "modules"), first: false, found: "hw" });
  });
  it("stays on a tab it has", () => {
    const v = at(view(1, "modules"));
    expect(settle(v, TABS, DIR)).toBe(v);
  });
  it("shows a document in the list of its kind, picked", () => {
    const hw: Thing = { type: "doc", course: 1, kind: "assignment", id: "55" };
    expect(settle(at(hw), TABS, DIR)).toMatchObject({ tab: view(1, "assignments"), item: "55" });
  });
  it("shows a document by itself when its list is hidden: on the tab at the end", () => {
    const v = at(page("schedule"));
    expect(settle(v, TABS, DIR)).toBe(v); // (the pages tab is hidden)
    expect(spareOf(v, TABS, true)).toEqual(page("schedule"));
  });
  it("shows a document that has a tab of its own on that tab", () => {
    const v = at(page("schedule"));
    expect(settle(v, [...TABS, { ...page("schedule"), hidden: false }, tab("pages")], DIR)).toBe(v);
  });
  it("shows a module in the modules tab, at it", () => {
    expect(settle(at({ type: "module", course: 1, module: 3 }), TABS, DIR)).toMatchObject({ tab: view(1, "modules"), item: "3" });
  });
  it("shows a folder in the folder tab that has it (the innermost), else in the files tab", () => {
    const week = `${DIR}/Files/Week 1`;
    const tabs = [...TABS, { ...folder(`${DIR}/Files`) }, { ...folder(week) }];
    expect(settle(at(folder(`${week}/notes`), { path: `${week}/notes` }), tabs, DIR)).toMatchObject({ tab: folder(week), path: `${week}/notes` });
    expect(settle(at(folder(`${DIR}/Modules`), { path: `${DIR}/Modules` }), tabs, DIR)).toMatchObject({ tab: view(1, "files"), path: `${DIR}/Modules` });
  });
});

describe("the tab at the end", () => {
  it("is the new tab while that shows, whatever was before it", () => {
    expect(spareOf(at(view(1, "modules"), { blank: true }), TABS, true)).toBe("new");
  });
  it("is nothing for one of the tabs, or before the tabs are known", () => {
    expect(spareOf(at(view(1, "modules")), TABS, true)).toBeNull();
    expect(spareOf(at(page("schedule")), [], false)).toBeNull();
  });
  it("closed, a new tab goes back to the tab before it, as it was", () => {
    const v = at(view(1, "announcements"), { item: "7", blank: true });
    expect(withoutSpare(v, TABS, undefined, DIR)).toEqual({ ...v, blank: false });
  });
  it("closed, something shown for now goes back to the tab last shown", () => {
    expect(withoutSpare(at(page("schedule")), TABS, view(1, "assignments"), DIR)).toMatchObject({ tab: view(1, "assignments"), blank: false });
  });
  it("closed, goes to the first tab when the one before isn't a tab any more", () => {
    expect(withoutSpare(at(page("schedule")), TABS, view(1, "pages"), DIR).tab).toEqual(view(1, "overview"));
    expect(withoutSpare(at(view(1, "pages"), { blank: true }), TABS, undefined, DIR).tab).toEqual(view(1, "overview"));
  });
});

describe("what's on screen", () => {
  it("is a tab's thing, or what its list has picked", () => {
    const reading = at(view(1, "announcements"), { item: "7" });
    expect(showing(reading, view(1, "announcements"))).toBe(true);
    expect(showing(reading, { type: "doc", course: 1, kind: "announcement", id: "7" })).toBe(true);
    expect(showing(reading, { type: "doc", course: 1, kind: "announcement", id: "8" })).toBe(false);
    expect(showing(reading, { type: "doc", course: 2, kind: "announcement", id: "7" })).toBe(false);
    expect(showing(at(view(1, "modules"), { item: "3" }), { type: "module", course: 1, module: 3 })).toBe(true);
  });
  it("is what's from Ed on Ed's list, too", () => {
    const ed = at(view(1, "ed"), { item: "ed-9" });
    expect(showing(ed, { type: "doc", course: 1, kind: "announcement", id: "ed-9" })).toBe(true);
    expect(showing(ed, { type: "doc", course: 1, kind: "post", id: "ed-9" })).toBe(true);
  });
  it("is the folder files are shown in, not one a tab only remembers", () => {
    const week = `${DIR}/Files/Week 1`;
    expect(showing(at(view(1, "files"), { path: week }), folder(week))).toBe(true);
    expect(showing(at(view(1, "grades"), { path: week }), folder(week))).toBe(false);
    expect(showing({ kind: "browse", path: week }, folder(week))).toBe(true);
    expect(showsFiles(at(view(1, "files"), { blank: true }))).toBe(false);
  });
  it("is the smart folder shown", () => {
    const search = { type: "search" as const, query: "mt", courses: [1], kinds: [], content: false };
    expect(showing({ kind: "search", search }, search)).toBe(true);
    expect(showing({ kind: "settings" }, search)).toBe(false);
  });
  it("counts hidden tabs as not there", () => {
    expect(listed(TABS, view(1, "pages"))).toBe(false);
    expect(listed(TABS, view(1, "files"))).toBe(true);
  });
});
