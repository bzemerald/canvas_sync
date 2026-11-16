// Each kind of thing (lib/things.ts), as both windows show it: its icon, what one is called when it
// has no name of its own, what they're called together (a query's chip: "Assignments"). A document is
// of its kind (announcement, assignment...); a course's views each have their own (`VIEWS`).
import {
  AppWindow, Award, BookOpen, ClipboardList, ExternalLink, FileText, Folder, FolderOpen, GraduationCap, LayoutDashboard,
  Link as LinkIcon, ListChecks, type LucideIcon, Megaphone, MessagesSquare, NotebookPen, ScrollText, Sparkles,
} from "lucide-react";
import { t } from "./i18n";
import type { KindId } from "./query";
import type { Thing, ViewName } from "./things";

export const KINDS: Record<KindId, { icon: LucideIcon; one: string; all: string }> = {
  course: { icon: GraduationCap, one: t("Course"), all: t("Course") },
  announcement: { icon: Megaphone, one: t("Announcements"), all: t("Announcements") },
  assignment: { icon: ClipboardList, one: t("Assignments"), all: t("Assignments") },
  page: { icon: BookOpen, one: t("Page"), all: t("Pages") },
  post: { icon: MessagesSquare, one: t("Post"), all: t("Post") },
  module: { icon: ListChecks, one: t("Module"), all: t("Modules") },
  tool: { icon: AppWindow, one: t("External tool"), all: t("External tool") },
  link: { icon: LinkIcon, one: t("Links"), all: t("Links") },
  note: { icon: NotebookPen, one: t("Notes"), all: t("Notes") },
  search: { icon: Sparkles, one: t("Smart folder"), all: t("Smart folder") },
  file: { icon: FileText, one: t("File"), all: t("Files") },
  folder: { icon: Folder, one: t("Folder"), all: t("Folder") },
};

/** What kind of thing it is (null: one of a course's views). */
export const kindOf = (x: Thing): KindId | null => (x.type === "doc" ? x.kind : x.type === "view" ? null : x.type);

/** A course's views: the icon, the name as a tab, as a card on its overview, as a row (in the
 * sidebar, in Tools and links): a card or a row without its own is called as the tab. */
export const VIEWS: Record<ViewName, { icon: LucideIcon; tab: string; card?: string; row?: string }> = {
  overview: { icon: LayoutDashboard, tab: t("Overview") },
  modules: { icon: ListChecks, tab: t("Modules"), card: t("This week's module") },
  announcements: { icon: Megaphone, tab: t("Announcements"), card: t("Latest announcements") },
  ed: { icon: MessagesSquare, tab: "Ed", card: "Ed" },
  assignments: { icon: ClipboardList, tab: t("Assignments"), card: t("Coming up") },
  grades: { icon: Award, tab: t("Grades") },
  files: { icon: FolderOpen, tab: t("Files"), card: t("Recently added files") },
  syllabus: { icon: ScrollText, tab: t("Syllabus"), card: t("Syllabus@@full"), row: t("Syllabus@@full") },
  pages: { icon: BookOpen, tab: t("Pages") },
  tools: { icon: AppWindow, tab: t("Tools and links") },
  canvas: { icon: ExternalLink, tab: t("Open in Canvas") },
};
