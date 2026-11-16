// What the app and the backend each work out for themselves, and must agree on: the cases in
// tests/shared/*.json, which the backend's tests run too (tests/test_shared.py).
import { describe, expect, it } from "vitest";
import canvasUrls from "../../../tests/shared/canvas_urls.json";
import things from "../../../tests/shared/things.json";
import words from "../../../tests/shared/words.json";
import { courseUrl, docUrl, fileUrl } from "./canvas";
import { STOPWORDS, sameSeries, seriesIn, singular } from "./query";
import { FIELDS, type Thing, type ThingOf, fromEd, ofCourse, same } from "./things";

describe("where things are on Canvas", () => {
  for (const c of canvasUrls.cases as ({ thing: Thing; url: string | null } | { file: number; course: number; url: string })[]) {
    it(JSON.stringify("file" in c ? c.file : c.thing), () => {
      const url = "file" in c ? fileUrl(c.course, c.file) : c.thing.type === "course" ? courseUrl(c.thing.course) : c.thing.type === "doc" ? docUrl(c.thing) : undefined;
      expect(url).toBe(c.url);
    });
  }
});

describe("things and places", () => {
  it("the fields that say which one a thing is", () => expect(FIELDS).toEqual(things.fields));
  for (const c of things.same as { a: Thing; b: Thing; same: boolean }[]) {
    it(`the same thing: ${JSON.stringify(c.a)} / ${JSON.stringify(c.b)}`, () => expect(same(c.a, c.b)).toBe(c.same));
  }
  for (const c of things.holds as { thing: Thing; holds: boolean }[]) {
    it(`a course's places hold: ${JSON.stringify(c.thing)}`, () => expect(ofCourse(c.thing, things.course)).toBe(c.holds));
  }
  for (const c of things.on_ed as (Pick<ThingOf<"doc">, "kind" | "id"> & { on_ed: boolean })[]) {
    it(`from Ed: ${c.kind} ${c.id}`, () => expect(fromEd({ type: "doc", course: 7, kind: c.kind, id: c.id })).toBe(c.on_ed));
  }
});

describe("words in what's searched for", () => {
  it("a word without its plural ending", () => {
    for (const [word, without] of words.singular) expect(singular(word), word).toBe(without);
  });
  for (const c of words.series_in as { name: string; series: [string, number][] }[]) {
    it(`the numbered things a name is: ${c.name}`, () => expect(seriesIn(c.name).map((s) => [s.name, s.n])).toEqual(c.series));
  }
  for (const c of words.same_series) {
    it(`a series by another name: ${c.a} / ${c.b}`, () => expect(sameSeries(c.a, c.b, words.abbreviations)).toBe(c.same));
  }
  it("the words that say little", () => expect([...STOPWORDS].sort()).toEqual([...words.stopwords].sort()));
});
