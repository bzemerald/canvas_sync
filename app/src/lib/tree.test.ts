import { describe, expect, it } from "vitest";
import { pathTree, type TreeNode } from "./tree";

const shape = (nodes: TreeNode<string>[]): unknown[] =>
  nodes.map((n) => (n.kind === "dir" ? { [n.name]: shape(n.children) } : n.name));
const tree = (paths: string[]) => shape(pathTree(paths, (p) => p));

describe("pathTree", () => {
  it("starts from the folder all the paths share", () => {
    expect(tree(["Fall/CS 70/Files/a.pdf", "Fall/CS 70/Modules/b.pdf"])).toEqual([{ Files: ["a.pdf"] }, { Modules: ["b.pdf"] }]);
  });

  it("shows one file by its name", () => {
    expect(tree(["Fall/CS 70/Files/a.pdf"])).toEqual(["a.pdf"]);
  });

  it("puts folders first, in natural order", () => {
    expect(tree(["c/z.pdf", "c/Week 10/a.pdf", "c/Week 2/a.pdf"])).toEqual([{ "Week 2": ["a.pdf"] }, { "Week 10": ["a.pdf"] }, "z.pdf"]);
  });

  it("joins a folder that holds only one folder with it", () => {
    expect(tree(["c/x.pdf", "c/Modules/Week 1/a.pdf", "c/Modules/Week 1/b.pdf"])).toEqual([{ "Modules/Week 1": ["a.pdf", "b.pdf"] }, "x.pdf"]);
  });

  it("knows each folder's path and everything below it", () => {
    const [dir] = pathTree(["c/x.pdf", "c/A/B/a.pdf", "c/A/B/b.pdf"], (p) => p);
    expect(dir.kind === "dir" && [dir.path, dir.leaves.length]).toEqual(["c/A/B", 2]);
  });
});
