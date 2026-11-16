// Search results and smart folder contents, behaving like a folder: click selects,
// double-click opens, ⌘/Ctrl/Shift-click and dragging a box select several, and the same
// keys as the file browser.
import { ExternalLink, FolderOpen } from "lucide-react";
import * as api from "../lib/api";
import type { Hit } from "../lib/api";
import { thingOfHit } from "../lib/things";
import { onTheWeb } from "./Things";
import { MarqueeBox } from "../lib/selection";
import { type ViewMode, useBrowser } from "./Browser";
import { ContentDivider, KIND, ResultBody, baseName, firstContentMatch, hitKey } from "./Result";
import { Thumb } from "./Thumb";
import { t } from "../lib/i18n";

export function HitBrowser({ hits, mode, showCourse, header, onOpen, onReveal, onMenu, onDelete, onCopy }: {
  hits: Hit[];
  mode: ViewMode;
  showCourse: boolean;
  header?: React.ReactNode; // shown above the items, inside the scroll area
  onOpen: (hit: Hit) => void; // a file opens; an announcement, assignment or page shows in the app
  onReveal: (hit: Hit) => void; // a file: show it in its folder, in the app
  onMenu: (hits: Hit[], x: number, y: number) => void;
  onDelete: (hits: Hit[]) => void; // only files that are on disk are passed
  onCopy: (hits: Hit[]) => void; // to the clipboard; the same
}) {
  const { scroller, marquee, onKeyDown, itemProps, shade } = useBrowser({
    items: hits, keyOf: hitKey, mode, onOpen, onMenu, onDelete, onCopy,
    deletable: onDisk, copyable: onDisk, previewPath: (h) => h.path,
    thing: (h) => thingOfHit(h) && { ...thingOfHit(h)!, name: h.title },
  });
  const divider = firstContentMatch(hits);

  return (
    <div
      ref={scroller}
      tabIndex={0}
      data-keys
      onKeyDown={(ev) => onKeyDown(ev)}
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
                title={showCourse ? `${h.title} · ${h.course}` : h.title}
                className={`flex flex-col items-center gap-1.5 rounded-lg p-2 ${shade(h)}`}
              >
                {h.path ? (
                  <Thumb path={h.path} name={baseName(h.path)} mtime={null} size={72} iconClass="size-12" />
                ) : (
                  <div className="flex size-18 items-center justify-center"><Icon className="size-10 text-muted" /></div>
                )}
                <span className="line-clamp-2 w-full text-center text-xs break-words">{h.title}</span>
                {showCourse && <span className="max-w-full truncate rounded bg-chip px-1.5 text-[10px] text-fg-soft">{h.course}</span>}
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
              title={h.path ? t("Double-click to open the file") : t("Double-click to open in Canvas")}
              className={`group flex items-start gap-2 rounded-lg px-2 py-2 ${shade(h)}`}
            >
              <div className="min-w-0 flex-1">
                <ResultBody hit={h} showCourse={showCourse} />
              </div>
              <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
                {h.path && (
                  <IconButton title={t("Show in folder")} onClick={() => onReveal(h)}>
                    <FolderOpen className="size-4" />
                  </IconButton>
                )}
                {h.url && (
                  <IconButton title={onTheWeb(h.url)} onClick={() => void api.openCanvas(h)}>
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

const onDisk = (h: Hit) => !!h.path;

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
