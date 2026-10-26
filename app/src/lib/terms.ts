// Terms in time order, newest first: "Fall 2026" > "Summer 2026" > "Spring 2026" > ...
const SEASON: Record<string, number> = { winter: 0, spring: 1, summer: 2, fall: 3, autumn: 3 };

/** Bigger is later; terms without a year last. */
export function termRank(term: string | null): number {
  const t = (term ?? "").toLowerCase();
  const year = Number(t.match(/\b(20\d\d)\b/)?.[1] ?? 0);
  const season = Object.entries(SEASON).find(([s]) => t.includes(s))?.[1] ?? -1;
  return year * 10 + season;
}

const YEAR = 365 * 24 * 3600 * 1000;

interface Dated {
  id: number;
  term: string | null;
  term_start: string | null;
  term_end: string | null;
  start_at: string | null;
  end_at: string | null;
}

/** Whether a course is going on, or still to come, by its term's dates (else its own). null: no
 * end date. A term that began over a year ago is a catch-all ("Default Term"), not this one. */
export function ongoing(c: Dated, now = Date.now()): boolean | null {
  const end = c.term_end ?? c.end_at;
  if (!end) return null;
  const start = c.term_start ?? c.start_at;
  return Date.parse(end) > now && !(start && Date.parse(start) < now - YEAR);
}

/** The courses to sync, before you choose: Canvas leaves most past courses "active", so those
 * going on now; with no dates to go by, the newest term's. */
export function currentCourses(courses: Dated[], now = Date.now()): number[] {
  const going = courses.filter((c) => ongoing(c, now));
  if (going.length) return going.map((c) => c.id);
  const newest = Math.max(0, ...courses.map((c) => termRank(c.term)));
  return courses.filter((c) => !newest || termRank(c.term) === newest).map((c) => c.id);
}
