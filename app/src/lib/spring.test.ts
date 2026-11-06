import { describe, expect, it } from "vitest";
import { Springs, step } from "./spring";

const run = (s: Springs<"x">, seconds: number, each = 1 / 60) => {
  const seen: number[] = [];
  for (let t = 0; t < seconds; t += each) {
    s.tick(each);
    seen.push(s.values.x);
  }
  return seen;
};

describe("springs", () => {
  it("get there, without going past it", () => {
    const s = new Springs({ x: 0 }, { x: 0.1 });
    s.set({ x: 100 });
    const seen = run(s, 0.4);
    expect(s.settled).toBe(true);
    expect(s.values.x).toBe(100);
    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true);
  });

  it("are most of the way there in about 150 ms", () => {
    const s = new Springs({ x: 0 }, { x: 0.1 });
    s.set({ x: 100 });
    run(s, 0.15);
    expect(s.values.x).toBeGreaterThan(90);
  });

  it("told somewhere else on the way, go on from where they are, smoothly", () => {
    const s = new Springs({ x: 0 }, { x: 0.1 });
    s.set({ x: 100 });
    const before = run(s, 0.05);
    s.set({ x: 0 });
    const after = run(s, 0.4);
    const seen = [...before, ...after];
    const jumps = seen.slice(1).map((v, i) => Math.abs(v - seen[i]));
    expect(Math.max(...jumps)).toBeLessThan(25); // (no step much bigger than a frame's)
    expect(after[0]).toBeGreaterThan(before.at(-1)!); // (still going the way it was, a moment)
    expect(s.values.x).toBe(0);
  });

  it("take a stall as one short step", () => {
    const s = new Springs({ x: 0 }, { x: 0.1 });
    s.set({ x: 100 });
    s.tick(5);
    expect(s.values.x).toBeLessThan(100);
    expect(s.settled).toBe(false);
  });

  it("at rest, stay", () => {
    expect(step(5, 0, 5, 0.1)).toEqual([5, 0]);
    const s = new Springs({ x: 5 }, { x: 0.1 });
    expect(s.settled).toBe(true);
  });
});
