// Search results and smart folder contents, behaving like a folder: click selects,
// double-click opens, ⌘/Ctrl/Shift-click and dragging a box select several, and the same
// keys as the file browser.
import { ExternalLink, FolderOpen } from "lucide-react";
import { useMemo, useRef } from "react";
import * as api from "../lib/api";
import type { Hit } from "../lib/api";
import { fileCommand, fileManager } from "../lib/keys";
import { MarqueeBox, useMarquee, useSelection } from "../lib/selection";
import type { ViewMode } from "./FileBrowser";
import { ContentDivider, KIND, ResultBody, firstContentMatch, hitKey } from "./Result";
import { Thumb } from "./Thumb";

export function HitBrowser({ hits, mode, showCourse, header, onMenu, onDelete }: {
  hits: Hit[];
  mode: ViewMode;
  showCourse: boolean;
  header?: React.ReactNode; // shown above the items, inside the scroll area
  onMenu: (hits: Hit[], x: number, y: number) => void;
  onDelete: (hits: Hit[]) => void; // only files that are on disk are passed
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => hits.map(hitKey), [hits]);
  const byKey = useMemo(() => new Map(hits.map((h) => [hitKey(h), h])), [hits]);
  const sel = useSelection(keys);
  const marquee = useMarquee(scroller, sel);
  const chosen = () => keys.filter((k) => sel.has(k)).map((k) => byKey.get(k)!);
  const divider = firstContentMatch(hits);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const i = keys.indexOf(sel.cursor ?? "");
    const gridEl = scroller.current?.querySelector<HTMLElement>("[data-grid]");
    const columns = mode === "grid" && gridEl ? getComputedStyle(gridEl).gridTemplateColumns.split(" ").length : 1;
    const go = (j: number) => {
      const k = keys[Math.max(0, Math.min(keys.length - 1, j))];
      if (k) sel.moveTo(k, ev.shiftKey);
    };
    const command = fileCommand(ev);
    const picked = chosen();
    const cur = byKey.get(sel.cursor ?? "");
    let handled = true;
    if (command === "open") picked.forEach((h) => void api.openHit(h));
    else if (command === "selectAll") sel.all();
    else if (command === "delete" && picked.some((h) => h.path)) onDelete(picked.filter((h) => h.path));
    else if (command === "preview" && cur?.path) void api.openPath(cur.path, { preview: true });
    else if (ev.key === "ArrowDown") go(i < 0 ? 0 : i + columns);
    else if (ev.key === "ArrowUp") go(i < 0 ? 0 : i - columns);
    else if (ev.key === "ArrowRight" && mode === "grid") go(i + 1);
    else if (ev.key === "ArrowLeft" && mode === "grid") go(i - 1);
    else if (ev.key === "Escape") sel.clear();
    else handled = false;
    if (handled) ev.preventDefault();
  };

  const itemProps = (h: Hit) => {
    const k = hitKey(h);
    return {
      "data-key": k,
      "aria-selected": sel.has(k),
      onMouseDown: (ev: React.MouseEvent) => ev.button === 0 && ev.detail > 1 && ev.preventDefault(),
      onClick: (ev: React.MouseEvent) => sel.click(k, ev),
      onDoubleClick: () => void api.openHit(h),
      onContextMenu: (ev: React.MouseEvent) => {
        ev.preventDefault();
        const picked = sel.has(k) ? chosen() : [h];
        if (!sel.has(k)) sel.only(k);
        onMenu(picked, ev.clientX, ev.clientY);
      },
    };
  };
  const shade = (h: Hit) => (sel.has(hitKey(h)) ? "bg-selected" : "hover:bg-chip");

  return (
    <div
      ref={scroller}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={marquee.onMouseDown}
      className="focus-quiet relative min-h-0 flex-1 overflow-y-auto px-4 py-3 pb-10"
    >
      <MarqueeBox box={marquee.box} />
      {header}
      {mode === "grid" ? (
        <div data-grid role="listbox" aria-multiselectable className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 py-2">
          {hits.map((h, i) => {
            const { icon: Icon } = KIND[h.kind] ?? KIND.file;
            return [
              i === divider && <ContentDivider key="divider" className="col-span-full" />,
              <div
                key={hitKey(h)}
                role="option"
                {...itemProps(h)}
                title={`${h.title} · ${h.course}`}
                className={`flex flex-col items-center gap-1.5 rounded-lg p-2 ${shade(h)}`}
              >
                {h.path ? (
                  <Thumb path={h.path} name={h.title} mtime={null} size={72} iconClass="size-12" />
                ) : (
                  <div className="flex size-18 items-center justify-center"><Icon className="size-10 text-muted" /></div>
                )}
                <span className="line-clamp-2 w-full text-center text-xs break-words">{h.title}</span>
                <span className="max-w-full truncate rounded bg-chip px-1.5 text-[10px] text-fg-soft">{h.course}</span>
              </div>,
            ];
          })}
        </div>
      ) : (
        <ul role="listbox" aria-multiselectable className="space-y-0.5">
          {hits.map((h, i) => [
            i === divider && <li key="divider"><ContentDivider /></li>,
            <li
              key={hitKey(h)}
              role="option"
              {...itemProps(h)}
              title={h.path ? "双击打开文件" : "双击在 Canvas 中打开"}
              className={`group flex items-start gap-2 rounded-lg px-2 py-2 ${shade(h)}`}
            >
              <div className="min-w-0 flex-1">
                <ResultBody hit={h} showCourse={showCourse} />
              </div>
              <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
                {h.path && (
                  <IconButton title={`在 ${fileManager} 中显示`} onClick={() => void api.openHit(h, true)}>
                    <FolderOpen className="size-4" />
                  </IconButton>
                )}
                {h.url && (
                  <IconButton title="在 Canvas 中打开" onClick={() => void api.openCanvas(h)}>
                    <ExternalLink className="size-4" />
                  </IconButton>
                )}
              </div>
            </li>,
          ])}
        </ul>
      )}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation(); // a shortcut, not a selection
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="rounded-md p-1.5 text-muted hover:bg-line hover:text-fg"
    >
      {children}
    </button>
  );
}
