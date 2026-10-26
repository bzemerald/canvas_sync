import { describe, expect, it } from "vitest";
import { currentCourses } from "./terms";

const now = Date.parse("2026-10-25T12:00:00Z");
const course = (id: number, term: string | null, dates: Partial<Record<"term_start" | "term_end" | "start_at" | "end_at", string>> = {}) =>
  ({ id, term, term_start: null, term_end: null, start_at: null, end_at: null, ...dates });

describe("currentCourses", () => {
  it("takes the courses going on now, and those still to come", () => {
    const fall = { term_start: "2026-08-20T00:00:00Z", term_end: "2026-12-20T00:00:00Z" };
    expect(currentCourses([
      course(1, "Fall 2026", fall),
      course(2, "Spring 2026", { term_start: "2026-01-10T00:00:00Z", term_end: "2026-05-20T00:00:00Z" }),
      course(3, "Spring 2027", { term_start: "2027-01-10T00:00:00Z", term_end: "2027-05-20T00:00:00Z" }),
      course(4, "Default Term", { term_start: "2010-01-01T00:00:00Z", term_end: "2099-01-01T00:00:00Z" }), // a catch-all
      course(5, "Default Term"),
      course(6, null, { end_at: "2026-11-01T00:00:00Z" }), // its own dates
    ], now)).toEqual([1, 3, 6]);
  });

  it("goes by the terms' names without dates", () => {
    expect(currentCourses([course(1, "Spring 2026"), course(2, "Fall 2026"), course(3, "Fall 2026"), course(4, "Fall 2025")], now)).toEqual([2, 3]);
    expect(currentCourses([course(1, "Orientation"), course(2, null)], now)).toEqual([1, 2]); // nothing to go by: all
  });
});
