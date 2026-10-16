// Terms in time order, newest first: "Fall 2026" > "Summer 2026" > "Spring 2026" > ...
const SEASON: Record<string, number> = { winter: 0, spring: 1, summer: 2, fall: 3, autumn: 3 };

/** Bigger is later; terms without a year last. */
export function termRank(term: string | null): number {
  const t = (term ?? "").toLowerCase();
  const year = Number(t.match(/\b(20\d\d)\b/)?.[1] ?? 0);
  const season = Object.entries(SEASON).find(([s]) => t.includes(s))?.[1] ?? -1;
  return year * 10 + season;
}
