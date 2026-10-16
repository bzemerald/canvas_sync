import { BookOpen, ClipboardList, ExternalLink, FileText, FolderOpen, Megaphone, ScrollText, type LucideIcon } from "lucide-react";
import { openCanvas, openHit, type Hit, type Kind } from "../lib/api";
import { Thumb } from "./Thumb";

export const KIND: Record<Kind, { icon: LucideIcon; label: string }> = {
  file: { icon: FileText, label: "文件" },
  page: { icon: BookOpen, label: "页面" },
  assignment: { icon: ClipboardList, label: "作业" },
  announcement: { icon: Megaphone, label: "公告" },
  syllabus: { icon: ScrollText, label: "大纲" },
};

export const isMac = navigator.userAgent.includes("Mac");
export const fileManager = isMac ? "Finder" : "文件管理器";

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("zh-CN", sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
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
          {!hit.path && hit.kind === "file" && <span className="shrink-0 text-xs text-muted">(未下载)</span>}
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
      正文中提到
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

export function HitList({ hits, showCourse, onMenu }: { hits: Hit[]; showCourse: boolean; onMenu: (h: Hit, x: number, y: number) => void }) {
  const divider = firstContentMatch(hits);
  return (
    <ul className="space-y-0.5">
      {hits.map((h, i) => [
        i === divider && <li key="divider"><ContentDivider /></li>,
        <li
          key={hitKey(h)}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu(h, e.clientX, e.clientY);
          }}
          className="group flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-selected"
        >
          <button className="min-w-0 flex-1 text-left" onClick={() => void openHit(h)} title={h.path ? "打开文件" : "在 Canvas 中打开"}>
            <ResultBody hit={h} showCourse={showCourse} />
          </button>
          <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            {h.path && (
              <IconButton title={`在 ${fileManager} 中显示`} onClick={() => void openHit(h, true)}>
                <FolderOpen className="size-4" />
              </IconButton>
            )}
            {h.url && (
              <IconButton title="在 Canvas 中打开" onClick={() => void openCanvas(h)}>
                <ExternalLink className="size-4" />
              </IconButton>
            )}
          </div>
        </li>,
      ])}
    </ul>
  );
}

/** The same, as icons with file previews. */
export function HitGrid({ hits, onMenu }: { hits: Hit[]; onMenu: (h: Hit, x: number, y: number) => void }) {
  const divider = firstContentMatch(hits);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 py-2">
      {hits.map((h, i) => {
        const { icon: Icon } = KIND[h.kind] ?? KIND.file;
        return [
          i === divider && <ContentDivider key="divider" className="col-span-full" />,
          <button
            key={hitKey(h)}
            onDoubleClick={() => void openHit(h)}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(h, e.clientX, e.clientY);
            }}
            title={`${h.title} · ${h.course}`}
            className="flex flex-col items-center gap-1.5 rounded-lg p-2 hover:bg-chip focus:bg-selected focus:outline-none"
          >
            {h.path ? (
              <Thumb path={h.path} name={h.title} mtime={null} size={72} iconClass="size-12" />
            ) : (
              <div className="flex size-18 items-center justify-center"><Icon className="size-10 text-muted" /></div>
            )}
            <span className="line-clamp-2 w-full text-center text-xs break-words">{h.title}</span>
            <span className="max-w-full truncate rounded bg-chip px-1.5 text-[10px] text-fg-soft">{h.course}</span>
          </button>,
        ];
      })}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-chip hover:text-fg">
      {children}
    </button>
  );
}
