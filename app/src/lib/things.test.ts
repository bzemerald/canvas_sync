import { describe, expect, it } from "vitest";
import { type Shown, putAt, slotIndex, view } from "./things";

const tab = (name: Parameters<typeof view>[1], hidden = false): Shown => ({ ...view(1, name), hidden });
const views = (l: Shown[]) => l.map((x) => [(x as { view: string }).view, !!x.hidden]);

describe("a hidden tab brought back", () => {
  const overview = tab("overview");
  const files = tab("files");
  const grades = tab("grades", true);
  const pages = tab("pages", true);
  const list = [overview, grades, files, pages];
  const shown = [overview, files];
  const back = (x: Shown) => putAt(list, { ...x, hidden: false }, slotIndex(list, shown, shown.length));

  it("is the last tab shown, the other hidden ones staying hidden", () => {
    expect(views(back(grades))).toEqual([["overview", false], ["files", false], ["grades", false], ["pages", true]]);
    expect(views(back(pages))).toEqual([["overview", false], ["grades", true], ["files", false], ["pages", false]]);
  });
});

describe("what a place has of its own", () => {
  const tools: Shown = { ...view(1, "tools"), own: true }; // (as the overview has it: one of its cards)
  const overview: Shown = { ...tab("overview"), own: true };

  it("stays its own when moved within the place", () => {
    expect(putAt([overview, tab("files")], overview, 2).map((x) => x.own)).toEqual([undefined, true]);
  });
  it("isn't the next place's own for having been another's: put there, it can be taken away", () => {
    expect(putAt([overview], tools, 1).map((x) => x.own)).toEqual([true, false]);
  });
});
