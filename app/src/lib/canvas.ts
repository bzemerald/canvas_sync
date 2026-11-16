// Where things are on Canvas (relative to the site), for what the backend gave no address with: a
// course, one of its documents, a file by its id there. As src/canvas_sync/urls.py has it
// (tests/shared/canvas_urls.json is what both must say). The rest come with theirs: a search
// result's `url`, `canvas_url` in the catalog.
import { type DocThingKind, type ThingOf, fromEd } from "./things";

export const courseUrl = (course: number) => `/courses/${course}`;
export const fileUrl = (course: number, file: number) => `${courseUrl(course)}/files/${file}`;

// Where Canvas keeps each kind of document (an announcement is a discussion topic).
const DOC_PATH: Partial<Record<DocThingKind, string>> = { page: "pages", assignment: "assignments", announcement: "discussion_topics" };

/** A document's page on Canvas. null: it's on Ed (where, comes with it: `Item.url`). */
export function docUrl(x: ThingOf<"doc">): string | null {
  const where = DOC_PATH[x.kind];
  return where && !fromEd(x) ? `${courseUrl(x.course)}/${where}/${encodeURIComponent(x.id)}` : null;
}
