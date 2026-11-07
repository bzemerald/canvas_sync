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
