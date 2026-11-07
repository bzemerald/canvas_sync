// What's marked on a page opened from search.
import { describe, expect, it } from "vitest";
import { compiled, locate, markPattern } from "./marks";
import { NO_VOCABULARY, type Reading, type Vocabulary, read } from "./query";

const vocab: Vocabulary = {
  ...NO_VOCABULARY,
  courses: [{ id: 70, keys: ["cs70", "70"] }],
  kinds: { 作业: "assignment", assignment: "assignment" }, // i18n-ignore
  series: new Map([["homework", new Set([3, 30])], ["problem set", new Set([3])], ["lecture", new Set([9])], ["midterm", new Set([2])], ["讲", new Set([3])]]), // i18n-ignore
  abbreviations: {
    mt: ["midterm", "prelim"], hw: ["homework", "problem set", "pset"], ps: ["problem set", "pset", "homework"], lec: ["lecture", "slides"],
    期中: ["midterm", "mt"], // i18n-ignore
  },
};

const marked = (query: string, text: string, snippet?: { text: string; match: boolean }[]) => {
  const pattern = markPattern(read(query, vocab), vocab, snippet);
  return pattern ? [...text.matchAll(compiled(pattern))].map((m) => m[0]) : [];
};

describe("markPattern", () => {
  it("marks a word and what it starts, whole, in any case", () => {
    expect(marked("midterm", "The MIDTERM and midterms, not premidterm")).toEqual(["MIDTERM", "midterms"]);
    expect(marked("lectu", "See Lecture notes")).toEqual(["Lecture"]);
  });

  it("marks short words only whole", () => {
    expect(marked("ab", "ab abs AB")).toEqual(["ab", "AB"]);
  });

  it("marks what a word stands for, either way", () => {
    expect(marked("mt", "MT review for the midterm or prelim")).toEqual(["MT", "midterm", "prelim"]);
    expect(marked("期中", "期中考试 and the midterm, MT")).toEqual(["期中", "midterm", "MT"]); // i18n-ignore
  });

  it("marks English next to Chinese", () => {
    expect(marked("midterm", "期中midterm考试")).toEqual(["midterm"]); // i18n-ignore
  });

  it("marks one of a series by any name, with its number", () => {
    expect(marked("hw3", "Homework 3, HW3, hw-03, Problem Set #3; not Homework 30, Homework 2, or homework")).toEqual(["Homework 3", "HW3", "hw-03", "Problem Set #3"]);
    expect(marked("midterm 2", "Midterm II and midterm 2, not Midterm III")).toEqual(["Midterm II", "midterm 2"]);
    expect(marked("第3讲", "第3讲 和 第 3 次讲，不是第4讲")).toEqual(["第3讲", "第 3 次讲"]); // i18n-ignore
  });

  it("takes words in quotes as they are", () => {
    expect(marked('"mt"', "mt, midterm, mts")).toEqual(["mt"]);
    expect(marked('"final exam"', "Final Exam, the final or the exam")).toEqual(["Final Exam"]);
  });

  it("leaves out what narrows a search down", () => {
    expect(markPattern(read("cs70 作业", vocab), vocab)).toBeUndefined(); // i18n-ignore
    expect(marked("cs70 作业 midterm", "CS70 作业 midterm")).toEqual(["midterm"]); // i18n-ignore
  });

  it("leaves out little words, unless there's nothing else", () => {
    expect(marked("the midterm", "the midterm")).toEqual(["midterm"]);
    expect(marked("the", "the midterm")).toEqual(["the"]);
  });

  it("marks what a result said matched, as it is", () => {
    const snippet = [{ text: "see ", match: false }, { text: "résumé", match: true }, { text: "x", match: true }];
    expect(marked("resume", "your résumé, x", snippet)).toEqual(["résumé"]);
  });

  it("has nothing to mark for nothing", () => {
    const none: Reading = { query: "", parts: [] };
    expect(markPattern(none, vocab)).toBeUndefined();
  });
});

describe("locate", () => {
  const pieces = (...xs: (string | [string])[]) => xs.map((x) => (typeof x === "string" ? { text: x, block: false } : { text: x[0], block: true }));

  it("finds what's within a piece", () => {
    expect(locate(pieces("one midterm"), compiled("midterm"))).toEqual([{ from: [0, 4], to: [0, 11] }]);
  });

  it("finds what goes across pieces of a block", () => {
    const re = compiled(markPattern(read("midterm 2", vocab), vocab)!);
    expect(locate(pieces("Midterm", " 2"), re)).toEqual([{ from: [0, 0], to: [1, 2] }]);
  });

  it("ends a match in the piece it ends, not the next", () => {
    expect(locate(pieces("midterm", " next"), compiled("midterm"))).toEqual([{ from: [0, 0], to: [0, 7] }]);
  });

  it("doesn't go across blocks", () => {
    const re = compiled(markPattern(read("midterm 2", vocab), vocab)!);
    expect(locate(pieces("Midterm", [" 2"]), re)).toEqual([]);
  });

  it("finds each, in order", () => {
    expect(locate(pieces("a x", ["x b"]), compiled("x")).map((m) => m.from)).toEqual([[0, 2], [1, 0]]);
  });
});
