// What the app can put somewhere (as the backend has it: src/canvas_sync/things.py): a course, a
// folder or a file, an announcement / assignment / page, a module, a tool, a web link, a saved
// search, a note, or one of a course's views (its overview, files, grades...). Places (置顶; a
// course's tabs, overview and 工具与链接) are lists of entries: a thing, what you call it there,
// whether it's hidden there. Anything can go anywhere; each place shows it its own way.
import type { DocKind, Hit, Kind, ModuleItem } from "./api";

export type ViewName =
  | "overview" | "modules" | "announcements" | "assignments" | "grades" | "files" | "syllabus" | "pages" | "tools" | "canvas";
export type DocThingKind = Exclude<DocKind, "syllabus">; // (the syllabus is a view)

export type Thing =
  | { type: "course"; course: number }
  | { type: "folder"; path: string }
  | { type: "file"; path: string }
  | { type: "doc"; course: number; kind: DocThingKind; id: string }
  | { type: "module"; course: number; module: number }
  | { type: "tool"; course: number; tool: number }
  | { type: "link"; url: string }
  | { type: "search"; query: string; courses: number[]; kinds: Kind[]; content: boolean }
  | { type: "note"; course: number; id: string }
  | { type: "view"; course: number; view: ViewName };
export type ThingOf<T extends Thing["type"]> = Extract<Thing, { type: T }>;

/** A thing in a place, as the backend lists it: your name for it there ("": its own), whether it's
 * hidden there; what it's called by itself now (what Canvas or the sync folder calls it; null for
 * what the app names), whether it's still there, the course it's in. */
export type Placed = Thing & { title: string; hidden: boolean; name: string | null; exists: boolean; in_course: number | null };
/** A thing in a place, or on its way there (just put there, or dragged: what's known of it). */
export type Shown = Thing & Partial<Omit<Placed, keyof Thing>>;

const FIELDS: { [T in Thing["type"]]: (keyof ThingOf<T>)[] } = {
  course: ["course"], folder: ["path"], file: ["path"], doc: ["course", "kind", "id"], module: ["course", "module"],
  tool: ["course", "tool"], link: ["url"], search: ["query", "courses", "kinds", "content"], note: ["course", "id"],
  view: ["course", "view"],
};

/** Just the thing (an entry without what the place says about it). */
export function thingOf(e: Thing): Thing {
  const out: Record<string, unknown> = { type: e.type };
  for (const k of FIELDS[e.type] as string[]) out[k] = (e as Record<string, unknown>)[k];
  return out as Thing;
}

/** Tells things apart (names don't count). */
export function thingKey(t: Thing): string {
  switch (t.type) {
    case "course": return `course:${t.course}`;
    case "folder": case "file": return `${t.type}:${t.path}`;
    case "doc": return `doc:${t.course}:${t.kind}:${t.id}`;
    case "module": return `module:${t.course}:${t.module}`;
    case "tool": return `tool:${t.course}:${t.tool}`;
    case "link": return `link:${t.url}`;
    case "search": return `search:${JSON.stringify([t.query, [...t.courses].sort(), [...t.kinds].sort(), t.content])}`;
    case "note": return `note:${t.course}:${t.id}`;
    case "view": return `view:${t.course}:${t.view}`;
  }
}
export const same = (a: Thing | null | undefined, b: Thing | null | undefined) => !!a && !!b && thingKey(a) === thingKey(b);

export const view = (course: number, name: ViewName): ThingOf<"view"> => ({ type: "view", course, view: name });
export function isView<N extends ViewName = ViewName>(t: Thing | null | undefined, name?: N): t is ThingOf<"view"> & { view: N } {
  return t?.type === "view" && (name === undefined || t.view === name);
}

/** The course a thing is a course's (its views, documents, modules, tools, notes; itself). Folders
 * and files are in one by where they are: see `Placed.in_course`, or `courseAt`. */
export const courseOf = (t: Thing): number | null => ("course" in t ? t.course : null);

/** Whether a thing is a course's own: its views, documents, modules, tools and notes, the folders
 * and files in its folder, a search of just that course. Within a course anything goes anywhere;
 * between courses there's a border: a course's places take only its things (and web links, which
 * are no course's). 置顶 is where things of different courses meet. */
export function ofCourse(t: Thing, course: { id: number; dir: string }): boolean {
  switch (t.type) {
    case "link": return true;
    case "course": return false;
    case "folder": case "file": return t.path === course.dir || t.path.startsWith(course.dir + "/");
    case "search": return t.courses.length === 1 && t.courses[0] === course.id;
    default: return t.course === course.id;
  }
}

/** Things that open somewhere else when you open them: a file in its app; a tool, a link or the
 * course on Canvas in the browser; a course on its own page. A tab of one opens it. */
export const opensElsewhere = (t: Thing) =>
  t.type === "file" || t.type === "tool" || t.type === "link" || t.type === "course" || isView(t, "canvas");

/** A search result, as a thing: the file, the announcement / assignment / page, the syllabus. */
export function thingOfHit(h: Hit): Thing | null {
  if (h.path) return { type: "file", path: h.path };
  if (h.kind === "syllabus") return view(h.course_id, "syllabus");
  if (h.doc_id && h.kind !== "file") return { type: "doc", course: h.course_id, kind: h.kind, id: h.doc_id };
  return null;
}

/** What a module item leads to, as a thing: its file, its page (or assignment...), its web link. */
export function thingOfItem(it: ModuleItem, course: number): Thing | null {
  if (it.deleted) return null;
  if (it.file) return { type: "file", path: it.file };
  if (it.doc) return it.doc.kind === "syllabus" ? view(course, "syllabus") : { type: "doc", course, kind: it.doc.kind, id: it.doc.id };
  if (it.external) return { type: "link", url: it.external };
  return null;
}

// -- changing what's in a place (each returns the place's new list) -------------------------------

const at = (list: Thing[], t: Thing) => list.findIndex((x) => same(x, t));

/** `entry` put at `index` (it's there already: moved there, shown). */
export function putAt<E extends Shown>(list: E[], entry: E, index: number): E[] {
  const was = at(list, entry);
  const rest = was < 0 ? list : list.filter((_, i) => i !== was);
  const kept = was < 0 ? entry : { ...list[was], hidden: false };
  const i = Math.max(0, Math.min(was >= 0 && was < index ? index - 1 : index, rest.length));
  return [...rest.slice(0, i), kept, ...rest.slice(i)];
}
export const without = <E extends Thing>(list: E[], t: Thing) => list.filter((x) => !same(x, t));
export const changed = <E extends Shown>(list: E[], t: Thing, change: { title?: string; hidden?: boolean }) =>
  list.map((x) => (same(x, t) ? { ...x, ...change } : x));

/** Where in `list` the `slot`th place among `shown` (some of it) is: before the one shown there,
 * or after the last one shown. */
export function slotIndex(list: Thing[], shown: Thing[], slot: number): number {
  if (slot < shown.length) return at(list, shown[slot]);
  return shown.length ? at(list, shown[shown.length - 1]) + 1 : list.length;
}

/** `list` with the items of `subset` (in it) in the order of `reordered`; the rest stay put. */
export function refill<T>(list: T[], subset: T[], reordered: T[]): T[] {
  const queue = [...reordered];
  return list.map((x) => (subset.includes(x) ? queue.shift()! : x));
}
