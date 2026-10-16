import { BookOpen, ClipboardList, FileText, Megaphone, ScrollText, type LucideIcon } from "lucide-react";
import type { Hit, Kind } from "../lib/api";
import { locale, t } from "../lib/i18n";

export const KIND: Record<Kind, { icon: LucideIcon; label: string }> = {
  file: { icon: FileText, label: t("文件") },
  page: { icon: BookOpen, label: t("页面") },
  assignment: { icon: ClipboardList, label: t("作业") },
  announcement: { icon: Megaphone, label: t("公告") },
  syllabus: { icon: ScrollText, label: t("大纲") },
};

export { fileManager, isMac } from "../lib/keys";

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function hitKey(h: Hit): string {
  return `${h.kind}:${h.course_id}:${h.path ?? h.url ?? h.title}`;
}

/** Icon, title, course/kind/date line, and the matching text. Shared by both windows. */
export function ResultBody({ hit, showCourse = true }: { hit: Hit; showCourse?: boolean }) {
  const { icon: Icon, label } = KIND[hit.kind] ?? KIND.file;
  const folder = hit.path ? hit.path.split("/").slice(2, -1).join(" / ") : "";
  return (
    <div className="flex min-w-0 gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium text-fg">{hit.title}</span>
          {!hit.path && hit.kind === "file" && <span className="shrink-0 text-xs text-muted">{t("(未下载)")}</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
          {showCourse && <span className="shrink-0 rounded bg-chip px-1.5 py-px text-fg-soft">{hit.course}</span>}
          <span className="shrink-0">{label}</span>
          {hit.date && <span className="shrink-0">· {formatDate(hit.date)}</span>}
          {folder && <span className="truncate">· {folder}</span>}
        </div>
        {hit.snippet.length > 0 && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-fg-soft">
            {hit.snippet.map((s, i) =>
              s.match ? (
                <mark key={i} className="rounded-sm bg-highlight px-0.5 text-fg">
                  {s.text}
                </mark>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** Search results / smart folder contents as rows. Click opens; right-click for more. */
/** Index of the first result that matched only inside the text (results come names first). */
export function firstContentMatch(hits: Hit[]): number {
  const i = hits.findIndex((h) => h.match === "content");
  return i > 0 ? i : -1; // no divider when nothing matched by name
}

export function ContentDivider({ className = "" }: { className?: string }) {
  return (
    <div role="separator" className={`flex items-center gap-2 px-2 pt-3 pb-1 text-xs text-muted ${className}`}>
      {t("正文中提到")}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
