// What the app and the backend each work out for themselves, and must agree on: the cases in
// tests/shared/*.json, which the backend's tests run too (tests/test_shared.py).
import { describe, expect, it } from "vitest";
import canvasUrls from "../../../tests/shared/canvas_urls.json";
import { courseUrl, docUrl, fileUrl } from "./canvas";
import type { Thing } from "./things";

describe("where things are on Canvas", () => {
  for (const c of canvasUrls.cases as ({ thing: Thing; url: string | null } | { file: number; course: number; url: string })[]) {
    it(JSON.stringify("file" in c ? c.file : c.thing), () => {
      const url = "file" in c ? fileUrl(c.course, c.file) : c.thing.type === "course" ? courseUrl(c.thing.course) : c.thing.type === "doc" ? docUrl(c.thing) : undefined;
      expect(url).toBe(c.url);
    });
  }
});
