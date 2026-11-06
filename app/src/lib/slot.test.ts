import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settling, lineIn, slotInColumn } from "./slot";

// Two columns: A (0-100) and B (116-216) in the first, C (0-100) in the second, in order A C B.
const A = { col: 0, top: 0, height: 100 };
const C = { col: 1, top: 0, height: 100 };
const B = { col: 0, top: 116, height: 100 };
const cards = [A, C, B];

describe("where a dragged card goes", () => {
  it("is before a card from above its middle, after it from below", () => {
    expect(slotInColumn(cards, 0, 49)).toBe(0); // before A
    expect(slotInColumn(cards, 0, 51)).toBe(2); // between A and B
    expect(slotInColumn(cards, 0, 165)).toBe(2);
    expect(slotInColumn(cards, 0, 167)).toBe(3); // after B
  });

  it("goes by the same middle whether a card is the column's last or not", () => {
    // A alone, as when B is what's dragged up its own column; and A above B, from the other column.
    expect(slotInColumn([A], 0, 49)).toBe(slotInColumn([A, B], 0, 49));
    expect(slotInColumn([A], 0, 51)).toBe(1);
    expect(slotInColumn([A, B], 0, 51)).toBe(1);
  });

  it("leaves the other column's cards where they are in the order", () => {
    expect(slotInColumn(cards, 1, 51)).toBe(2); // after C, before B (in the other column)
  });

  it("is the end in an empty column", () => {
    expect(slotInColumn([A, B], 1, 10)).toBe(2);
    expect(slotInColumn([], 0, 10)).toBe(0);
  });
});

describe("the line showing where it goes", () => {
  it("is in the gap above the card it goes before", () => {
    expect(lineIn(cards, 0, 0, 16)).toBe(-8);
    expect(lineIn(cards, 0, 2, 16)).toBe(108);
    expect(lineIn(cards, 0, 1, 16)).toBe(108); // (C, between in the order, is in the other column)
  });
  it("is below the column's last, past its end", () => {
    expect(lineIn(cards, 0, 3, 16)).toBe(224);
    expect(lineIn(cards, 1, 3, 16)).toBe(108);
  });
  it("is at the top of an empty column", () => {
    expect(lineIn([A, B], 1, 2, 16)).toBe(0);
    expect(lineIn([], 0, 0, 16)).toBe(0);
  });
});

describe("what's shown settling", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  const start = () => {
    const seen: string[] = [];
    return { seen, s: new Settling<string>(100, (v) => seen.push(v)) };
  };

  it("shows the first at once, the next once it has held", () => {
    const { s, seen } = start();
    expect(s.see("a", "a")).toBe("a");
    expect(s.see("b", "b")).toBe("a");
    vi.advanceTimersByTime(99);
    expect(s.see("b", "b")).toBe("a"); // (seeing it again doesn't start over)
    vi.advanceTimersByTime(1);
    expect(s.see("b", "b")).toBe("b");
    expect(seen).toEqual(["a", "b"]);
  });

  it("changes nothing for what comes and goes", () => {
    const { s, seen } = start();
    s.see("a", "a");
    for (let i = 0; i < 10; i++) {
      s.see(i % 2 ? "a" : "b", i % 2 ? "a" : "b");
      vi.advanceTimersByTime(30);
    }
    s.see("a", "a");
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["a"]);
  });

  it("back on what's shown, the wait is off", () => {
    const { s, seen } = start();
    s.see("a", "a");
    s.see("b", "b");
    s.see("a", "a");
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["a"]);
  });

  it("over, it waits for nothing and starts anew", () => {
    const { s, seen } = start();
    s.see("a", "a");
    s.see("b", "b");
    s.clear();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["a"]);
    s.see("c", "c");
    expect(seen).toEqual(["a", "c"]);
  });
});
