// Each kind of thing (lib/things.ts), as both windows show it: its icon, what one is called when it
// has no name of its own, what they're called together (a query's chip: "作业"). A document is
// of its kind (announcement, assignment...); a course's views each have their own (`VIEWS`).
import {
  AppWindow, Award, BookOpen, ClipboardList, ExternalLink, FileText, Folder, FolderOpen, GraduationCap, LayoutDashboard,
  Link as LinkIcon, ListChecks, type LucideIcon, Megaphone, MessagesSquare, NotebookPen, ScrollText, Sparkles,
} from "lucide-react";
import { t } from "./i18n";
import type { KindId } from "./query";
import type { Thing, ViewName } from "./things";

export const KINDS: Record<KindId, { icon: LucideIcon; one: string; all: string }> = {
  course: { icon: GraduationCap, one: t("课程"), all: t("课程") },
  announcement: { icon: Megaphone, one: t("公告"), all: t("公告") },
  assignment: { icon: ClipboardList, one: t("作业"), all: t("作业") },
  page: { icon: BookOpen, one: t("页面@@card"), all: t("页面") },
  post: { icon: MessagesSquare, one: t("帖子"), all: t("帖子") },
  module: { icon: ListChecks, one: t("模块@@card"), all: t("模块") },
  tool: { icon: AppWindow, one: t("外部工具"), all: t("外部工具") },
  link: { icon: LinkIcon, one: t("链接"), all: t("链接") },
  note: { icon: NotebookPen, one: t("备忘录"), all: t("备忘录") },
  search: { icon: Sparkles, one: t("智能文件夹"), all: t("智能文件夹") },
  file: { icon: FileText, one: t("文件@@card"), all: t("文件") },
  folder: { icon: Folder, one: t("文件夹"), all: t("文件夹") },
};

/** What kind of thing it is (null: one of a course's views). */
export const kindOf = (x: Thing): KindId | null => (x.type === "doc" ? x.kind : x.type === "view" ? null : x.type);

/** A course's views: the icon, the name as a tab, as a card on its overview, as a row (in the
 * sidebar, in 工具与链接): a card or a row without its own is called as the tab. */
export const VIEWS: Record<ViewName, { icon: LucideIcon; tab: string; card?: string; row?: string }> = {
  overview: { icon: LayoutDashboard, tab: t("概览") },
  modules: { icon: ListChecks, tab: t("模块"), card: t("当前模块") },
  announcements: { icon: Megaphone, tab: t("公告"), card: t("最新公告") },
  ed: { icon: MessagesSquare, tab: "Ed", card: "Ed" },
  assignments: { icon: ClipboardList, tab: t("作业"), card: t("近期截止") },
  grades: { icon: Award, tab: t("成绩") },
  files: { icon: FolderOpen, tab: t("文件"), card: t("最近新增的文件") },
  syllabus: { icon: ScrollText, tab: t("大纲"), card: t("课程大纲"), row: t("课程大纲") },
  pages: { icon: BookOpen, tab: t("页面") },
  tools: { icon: AppWindow, tab: t("工具与链接") },
  canvas: { icon: ExternalLink, tab: t("在 Canvas 中打开") },
};
