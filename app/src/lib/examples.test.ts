// Example searches (examples.ts): made from what the courses have, and each finds something.
import { describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "./api";
import { type Describe, find, prepare, vocabulary } from "./find";
import { read } from "./query";

vi.mock("./i18n", () => ({ t: (s: string, v: Record<string, string> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]) }));
const { examples, seeded } = await import("./examples");

const NOW = Date.parse("2026-10-21T19:00:00Z"); // a Wednesday
const day = (n: number) => new Date(NOW + n * 864e5).toISOString();
const EE = 1, NEU = 2, OLD = 3;

const entry = (thing: object, course: number | null, fields: Partial<CatalogEntry> = {}) =>
  ({ ...thing, name: null, title: "", aliases: [], in_course: course, ...fields }) as CatalogEntry;
const course = (id: number, name: string, term: string, keys: string[]) => entry({ type: "course", course: id }, id, { name, term, keys });
const file = (c: number, path: string) => entry({ type: "file", path }, c, { name: path.split("/").pop()! });
let ids = 0;
const doc = (c: number, kind: string, name: string, fields: Partial<CatalogEntry> = {}) =>
  entry({ type: "doc", course: c, kind, id: String(++ids) }, c, { name, ...fields });

const things: CatalogEntry[] = [
  course(EE, "EE 64", "Fall 2026", ["64", "ee64", "eleng64"]),
  course(NEU, "NEU 198", "Fall 2026", ["198", "neu198"]),
  course(OLD, "CS 61A", "Fall 2025", ["61a", "cs61a"]),
  ...[5, 6, 7].map((n) => doc(EE, "assignment", `Homework ${n}`, { due: day(n - 7), date: day(n - 7), status: "submitted" })),
  file(EE, "Fall 2026/EE 64/Files/HW/EE64_FA26_HW6_Sol.pdf"),
  file(EE, "Fall 2026/EE 64/Files/HW/EE64_FA26_HW5_Sol.pdf"),
  doc(EE, "post", "Lab Attendance", { date: day(-1), source: "ed" }),
  doc(NEU, "announcement", "First Class Tonight", { date: day(-40) }),
  doc(NEU, "assignment", "Final Project Proposal", { due: day(2), date: day(2), status: "unsubmitted" }),
  ...[1, 2].map((n) => doc(OLD, "assignment", `Lab ${n}`, { due: day(-300), date: day(-300) })),
];
const describe_: Describe = (e) => ({
  names: [e.type === "file" ? e.path.split("/").pop()! : e.name ?? ""], aliases: e.aliases, kind: [e.type === "doc" ? e.kind : e.type],
});
const catalog = prepare(things, describe_, { hw: ["homework", "problem set"], sol: ["solution", "answers"] });
const vocab = vocabulary(catalog, { announcements: "announcement", 公告: "announcement" }); // i18n-ignore
const all = (lang: "en" | "zh", seed = 1) => examples(catalog, vocab, [EE, NEU], NOW, lang, 6, seeded(seed));

describe("examples", () => {
  it("shows each way once, from what the current courses have", () => {
    const xs = all("en");
    expect(xs.map((x) => x.shows).sort()).toEqual(["answer", "due", "ed", "kind", "number", "status"]);
    const ee = "(64|ee64|eleng64)", neu = "(198|neu198)";
    expect(xs.find((x) => x.shows === "number")?.query).toMatch(new RegExp(`^${ee} hw[567]$`));
    expect(xs.find((x) => x.shows === "answer")?.query).toMatch(new RegExp(`^${ee} hw[56] sol$`));
    expect(xs.find((x) => x.shows === "kind")?.query).toMatch(new RegExp(`^${neu} announcements$`));
    expect(xs.find((x) => x.shows === "due")?.query).toMatch(new RegExp(`^${neu} due this week$`));
    expect(xs.find((x) => x.shows === "status")?.query).toMatch(new RegExp(`^${neu} todo$`));
    expect(xs.find((x) => x.shows === "ed")?.query).toMatch(new RegExp(`^${ee} ed$`));
    expect(xs.some((x) => x.course === OLD)).toBe(false);
  });

  it("finds something, every one of them, in either language", () => {
    for (const lang of ["en", "zh"] as const) {
      for (const seed of [1, 7, 42]) {
        for (const x of all(lang, seed)) {
          const r = find(read(x.query, vocab, NOW), catalog, { opened: {}, picks: [] }, [], [], NOW);
          expect(r.top, x.query).not.toBeNull();
        }
      }
    }
    expect(all("zh").find((x) => x.shows === "kind")?.query).toMatch(/^(198|neu198) 公告$/); // i18n-ignore
  });

  it("says a course in its different ways, now and then; the same for the same seed", () => {
    const said = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => all("en", seed).find((x) => x.shows === "ed")!.query));
    expect(said.size).toBeGreaterThan(1);
    expect(all("en", 5)).toEqual(all("en", 5));
  });

  it("gives none of a way the courses have nothing for", () => {
    expect(examples(catalog, vocab, [OLD], NOW, "en").map((x) => x.shows)).toEqual(["number"]);
    expect(examples(catalog, vocab, [], NOW, "en")).toEqual([]);
  });
});
