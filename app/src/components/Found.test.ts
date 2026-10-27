// What ⇥ makes of a query (completion): a course's name, else the word being typed.
import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../lib/api";
import { nameWords, prepare, vocabulary } from "../lib/find";
import { type KindId, read } from "../lib/query";

// (i18n.ts sets the page's language as it loads: there's no page here)
Object.assign(globalThis, { document: { documentElement: {} } });
const { completion } = await import("./Found");

const entry = (fields: object) => ({ name: null, title: "", aliases: [], ...fields }) as unknown as CatalogEntry;
const things: CatalogEntry[] = [
  entry({ type: "course", course: 16, name: "EE 16A", term: "Fall 2026", keys: ["ee16a", "16a"], in_course: null }),
  entry({ type: "course", course: 61, name: "CS 61A", term: "Fall 2026", keys: ["cs61a", "61a"], in_course: null }),
  ...[1, 2, 3].map((n) => entry({ type: "file", path: `EE 16A/Worksheet ${n}.pdf`, name: `Worksheet ${n}.pdf`, in_course: 16 })),
  entry({ type: "doc", course: 61, kind: "page", id: "w", name: "Workshop signup", in_course: 61 }),
  entry({ type: "doc", course: 16, kind: "announcement", id: "a", name: "Room change", in_course: 16 }),
];
const KINDS: Record<string, KindId> = { announcement: "announcement", page: "page" };
const catalog = prepare(things, (e) => ({ names: [e.name ?? ""], aliases: [], kind: [] }));
const vocab = vocabulary(catalog, KINDS);
const words = nameWords(catalog, { opened: {}, picks: [] }, KINDS);
const complete = (q: string) => completion(read(q, vocab), undefined, [], words);

describe("going on from the word being typed", () => {
  it("finishes it, and a space after", () => {
    expect(complete("wor")).toBe("worksheet ");
    expect(complete("ann")).toBe("announcement ");
  });

  it("by the course and the kind the query says", () => {
    expect(complete("cs61a wor")).toBe("cs61a workshop ");
    expect(complete("page wor")).toBe("page workshop ");
  });

  it("keeps what's typed as it was typed", () => {
    expect(complete("Wor")).toBe("Worksheet ");
  });

  it("not once it's done, or in quotes", () => {
    expect(complete("wor ")).toBeNull();
    expect(complete('"wor')).toBeNull();
  });
});
