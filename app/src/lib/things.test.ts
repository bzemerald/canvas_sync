import { describe, expect, it } from "vitest";
import { thingOfLink } from "./things";

describe("thingOfLink", () => {
  it("reads a thing's fields from the query", () => {
    expect(thingOfLink("canvas-sync://open?type=doc&course=12&kind=assignment&id=34"))
      .toEqual({ type: "doc", course: 12, kind: "assignment", id: "34" });
    expect(thingOfLink("canvas-sync://open?type=file&path=CS+70%2Fhw%203.pdf")).toEqual({ type: "file", path: "CS 70/hw 3.pdf" });
    expect(thingOfLink("canvas-sync://open?type=view&course=12&view=grades")).toEqual({ type: "view", course: 12, view: "grades" });
  });
  it("is null for anything else", () => {
    expect(thingOfLink("canvas-sync://open?type=doc&course=12&kind=assignment")).toBeNull(); // (no id)
    expect(thingOfLink("canvas-sync://open?type=module&course=x&module=1")).toBeNull();
    expect(thingOfLink("canvas-sync://open?type=link&url=https%3A%2F%2Fexample.com")).toBeNull();
    expect(thingOfLink("https://open?type=course&course=1")).toBeNull();
    expect(thingOfLink("not a link")).toBeNull();
  });
});
