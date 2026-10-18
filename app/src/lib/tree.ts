/** A folder of a tree of paths, or one of its leaves. */
export type TreeNode<T> =
  | { kind: "dir"; name: string; path: string; children: TreeNode<T>[]; leaves: T[] } // leaves: all below
  | { kind: "leaf"; name: string; path: string; item: T };

/** Paths as a tree, from the folder they all share: folders first, in natural order ("Week 2"
 * before "Week 10"), and a folder holding only one folder joined with it ("Modules/Week 1"). */
export function pathTree<T>(items: T[], pathOf: (x: T) => string): TreeNode<T>[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const split = items.map((x) => ({ item: x, parts: pathOf(x).split("/") }));
  // The folders every path is in (a single path keeps its own folder out: it's a leaf).
  let shared = split.length ? split[0].parts.length - 1 : 0;
  for (const { parts } of split) {
    let i = 0;
    while (i < shared && i < parts.length - 1 && parts[i] === split[0].parts[i]) i++;
    shared = i;
  }
  const build = (rows: typeof split, depth: number, base: string): TreeNode<T>[] => {
    const dirs = new Map<string, typeof split>();
    const leaves: TreeNode<T>[] = [];
    for (const r of rows) {
      const name = r.parts[depth];
      if (depth === r.parts.length - 1) leaves.push({ kind: "leaf", name, path: base + name, item: r.item });
      else dirs.set(name, [...(dirs.get(name) ?? []), r]);
    }
    const folders: TreeNode<T>[] = [...dirs].map(([name, inside]) => {
      let children = build(inside, depth + 1, `${base}${name}/`);
      let label = name;
      while (children.length === 1 && children[0].kind === "dir") {
        label = `${label}/${children[0].name}`;
        children = children[0].children;
      }
      return { kind: "dir", name: label, path: base + label, children, leaves: inside.map((r) => r.item) };
    });
    const byName = (a: TreeNode<T>, b: TreeNode<T>) => collator.compare(a.name, b.name);
    return [...folders.sort(byName), ...leaves.sort(byName)];
  };
  return build(split, shared, split.length ? split[0].parts.slice(0, shared).map((p) => p + "/").join("") : "");
}
