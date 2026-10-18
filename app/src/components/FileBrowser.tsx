// A folder's contents, like the platform's file manager: a list whose folders expand in
// place, or an icon grid. Click / ⌘-or-Ctrl-click / Shift-click / drag a box to select;
// keys follow Finder on macOS and Explorer elsewhere (see lib/keys.ts); arrows move,
// → / ← expand and collapse in the list.
import { ChevronDown, ChevronRight, ChevronUp, CornerUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { quickLook } from "../lib/quicklook";
import type { Entry } from "../lib/api";
import { fileCommand } from "../lib/keys";
import { thingOfEntry, useDragThing, useThings } from "./Things";
import { MarqueeBox, useMarquee, useSelection } from "../lib/selection";
import { FileIcon } from "./FileIcon";
import { RenameInput } from "./RenameInput";
import { IconMarks, NewDot, StatusBadges } from "./Status";
import { Thumb } from "./Thumb";
import { locale, t } from "../lib/i18n";

export type ViewMode = "list" | "grid";
type SortKey = "name" | "date" | "size";

interface Props {
  path: string;
  root: string; // don't go above this (a course's own folder, or "" for everything)
  inline?: string; // a folder in `root` shown as `root` itself: its contents there, in its place
  missing?: string; // what to say when `root` isn't there (a course with no files)
  marked?: Record<string, { icon: React.ComponentType<{ className?: string }>; note: string }>; // folders listed first, with what they are
  version: number; // bump to reload (after a sync, a restore, or the window regaining focus)
  mode: ViewMode;
  showChanges: boolean; // what you changed: deleted files, and badges for your changes
  select?: string | null; // a path to select once it's listed
  onNavigate: (path: string) => void;
  onOpen: (e: Entry) => void;
  onMenu: (entries: Entry[], x: number, y: number) => void; // the selection, right-clicked
  onFolderMenu: (x: number, y: number) => void; // the folder itself: right-clicked where nothing is
  onDelete: (entries: Entry[]) => void;
  renaming: string | null; // path of the folder being renamed in place
  onStartRename: (e: Entry) => void;
  onRename: (e: Entry, name: string) => void;
  onRenameCancel: () => void;
}

export const canRename = (e: Entry) => e.type === "dir" && !e.deleted;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function formatSize(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatTime(seconds: number | null): string {
  if (seconds == null) return "";
  const d = new Date(seconds * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t("今天 {time}", { time: d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) });
  return d.toLocaleDateString(locale, d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function FileBrowser({
  path, root, inline, missing: missingNote, marked, version, mode, showChanges, select, onNavigate, onOpen, onMenu, onFolderMenu, onDelete,
  renaming, onStartRename, onRename, onRenameCancel,
}: Props) {
  const dragThing = useDragThing(); // (置顶 is in their menus)
  const { courses } = useThings();
  const [listings, setListings] = useState<Record<string, Entry[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false); // the folder isn't there (a course with no files yet)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  const load = useCallback(async (dir: string) => {
    try {
      const entries = await api.tree(dir);
      setListings((l) => ({ ...l, [dir]: entries }));
      if (dir === path) {
        setError(null);
        setMissing(false);
      }
    } catch (e) {
      if (dir === path && e instanceof api.ApiError && e.status === 404) setMissing(true);
      else if (dir === path) setError((e as Error).message);
      else setExpanded((x) => new Set([...x].filter((p) => p !== dir))); // vanished: fold it
    }
  }, [path]);

  // New folder: start fresh. Same folder, new version: reload it and everything expanded.
  useEffect(() => {
    setExpanded(new Set());
    setListings({});
    setMissing(false);
    box.current?.focus();
  }, [path]);
  const merged = inline !== undefined && path === root ? inline : null; // (its contents are the root's)
  useEffect(() => {
    void load(path);
    if (merged !== null) void load(merged);
    expanded.forEach((d) => void load(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, load, merged]);
  const listed = useCallback(
    (dir: string) => (dir === path && merged !== null && listings[path]
      ? [...listings[path].filter((e) => e.path !== merged || e.deleted), ...(listings[merged] ?? [])]
      : listings[dir]),
    [listings, path, merged],
  );

  const sorted = useCallback(
    (entries: Entry[]) => {
      const visible = showChanges ? entries : entries.filter((e) => !e.deleted);
      const cmp = (a: Entry, b: Entry) => {
        const v = sort.key === "date" ? (a.mtime ?? 0) - (b.mtime ?? 0)
          : sort.key === "size" ? (a.size ?? 0) - (b.size ?? 0)
          : collator.compare(a.name, b.name);
        return (sort.desc ? -v : v) || collator.compare(a.name, b.name);
      };
      const rank = (e: Entry) => (marked?.[e.path] ? 0 : e.type === "dir" ? 1 : 2);
      return [...visible].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
    },
    [showChanges, sort, marked],
  );

  // The rows on screen, in order: expanded folders' children follow them (list view only).
  const rows = useMemo(() => {
    const out: { entry: Entry; depth: number }[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of sorted(listed(dir) ?? [])) {
        out.push({ entry, depth });
        if (mode === "list" && entry.type === "dir" && !entry.deleted && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(path, 0);
    return out;
  }, [listed, path, expanded, mode, sorted]);

  const keys = useMemo(() => rows.map((r) => r.entry.path), [rows]);
  const byPath = useMemo(() => new Map(rows.map((r) => [r.entry.path, r.entry])), [rows]);
  const sel = useSelection(keys);
  const marquee = useMarquee(scroller, sel);
  const chosen = () => keys.filter((k) => sel.has(k)).map((k) => byPath.get(k)!);

  // What's selected, for Quick Look; when it's open it follows the selection, as in Finder.
  const previewable = rows.filter((r) => sel.has(r.entry.path) && !r.entry.deleted).map((r) => r.entry.path);
  const preview = (how: "toggle" | "follow") => quickLook(previewable, Math.max(0, previewable.indexOf(sel.cursor ?? "")), how);
  useEffect(() => {
    void preview("follow");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewable.join("\0"), sel.cursor]);

  // Select `select` once it shows up (a "show original" jump), but only once: later reloads
  // keep whatever you've selected since.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (select && applied.current !== select && byPath.has(select)) {
      applied.current = select;
      sel.only(select);
    }
  }, [select, byPath, sel]);

  useEffect(() => {
    if (sel.cursor) scroller.current?.querySelector(`[data-key="${CSS.escape(sel.cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel.cursor]);

  const toggle = (dir: string, open?: boolean) => {
    setExpanded((x) => {
      const next = new Set(x);
      const willOpen = open ?? !next.has(dir);
      if (willOpen) {
        next.add(dir);
        if (!listings[dir]) void load(dir);
      } else {
        for (const p of next) if (p === dir || p.startsWith(dir + "/")) next.delete(p);
      }
      return next;
    });
  };

  const activate = (e: Entry) => (e.type === "dir" && !e.deleted ? onNavigate(e.path) : onOpen(e));

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.entry.path === sel.cursor);
    const cur = i >= 0 ? rows[i] : null;
    const focused = cur && sel.has(cur.entry.path) ? cur.entry : null; // (deselected: nothing to rename)
    const go = (j: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (r) sel.moveTo(r.entry.path, ev.shiftKey);
    };
    const columns = mode === "grid" && grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length : 1;
    const command = fileCommand(ev);
    const picked = chosen();
    let handled = true;
    if (command === "open") picked.forEach(activate);
    else if (command === "parent") path !== root && path && onNavigate(parentOf(path) === inline ? root : parentOf(path));
    else if (command === "selectAll") sel.all();
    else if (command === "delete") picked.length ? onDelete(picked) : (handled = false);
    else if (command === "rename") focused && canRename(focused) ? onStartRename(focused) : (handled = false);
    else if (command === "preview") void preview("toggle");
    else if (ev.key === "ArrowDown") go(i < 0 ? 0 : i + columns);
    else if (ev.key === "ArrowUp") go(i < 0 ? 0 : i - columns);
    else if (ev.key === "ArrowRight" && mode === "grid") go(i + 1);
    else if (ev.key === "ArrowLeft" && mode === "grid") go(i - 1);
    else if (ev.key === "ArrowRight" && cur?.entry.type === "dir" && !cur.entry.deleted) {
      if (!expanded.has(cur.entry.path)) toggle(cur.entry.path, true);
      else go(i + 1);
    } else if (ev.key === "ArrowLeft" && cur) {
      if (cur.entry.type === "dir" && expanded.has(cur.entry.path)) toggle(cur.entry.path, false);
      else if (cur.depth > 0) sel.only(parentOf(cur.entry.path));
    } else if (ev.key === "Escape") sel.clear();
    else handled = false;
    if (handled) ev.preventDefault();
  };

  const itemProps = (e: Entry) => ({
    "data-key": e.path,
    "aria-selected": sel.has(e.path),
    onMouseDown: (ev: React.MouseEvent) => ev.button === 0 && ev.detail > 1 && ev.preventDefault(), // no word selection on double-click
    onClick: (ev: React.MouseEvent) => sel.click(e.path, ev),
    onDoubleClick: () => activate(e),
    ...dragThing(e.deleted ? null : thingOfEntry(e, courses)),
    onContextMenu: (ev: React.MouseEvent) => {
      ev.preventDefault();
      // Right-clicking outside the selection acts on that item alone, as in Finder/Explorer.
      const picked = sel.has(e.path) ? chosen() : [e];
      if (!sel.has(e.path)) sel.only(e.path);
      onMenu(picked, ev.clientX, ev.clientY);
    },
  });

  const loaded = listings[path] !== undefined;
  const empty = loaded && rows.length === 0;
  const shade = (e: Entry) => (sel.has(e.path) ? "bg-selected" : "hover:bg-chip");

  return (
    <div ref={box} tabIndex={0} onKeyDown={onKeyDown} className="focus-quiet flex min-h-0 flex-1 flex-col">
      {mode === "list" && (
        <div className="grid grid-cols-[minmax(0,1fr)_10rem_7.5rem_5rem] gap-3 border-b border-line px-6 py-1.5 text-xs text-muted">
          <SortHeader label={t("名称")} k="name" sort={sort} setSort={setSort} />
          <span>{t("状态")}</span>
          <SortHeader label={t("修改日期")} k="date" sort={sort} setSort={setSort} />
          <SortHeader label={t("大小")} k="size" sort={sort} setSort={setSort} right />
        </div>
      )}
      <div
        ref={scroller}
        onMouseDown={marquee.onMouseDown}
        onContextMenu={(ev) => {
          if ((ev.target as HTMLElement).closest("[data-key]")) return; // (an item: its own menu)
          ev.preventDefault();
          sel.clear();
          onFolderMenu(ev.clientX, ev.clientY);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto px-3 py-1 pb-10"
      >
        <MarqueeBox box={marquee.box} />
        {error && <p className="px-3 py-6 text-sm text-danger whitespace-pre-wrap">{error}</p>}
        {empty && !error && <p className="px-3 py-10 text-center text-sm text-muted">{t("这个文件夹是空的")}</p>}
        {missing && !error && (
          <p className="px-3 py-10 text-center text-sm text-muted">
            {path === root && missingNote ? missingNote : t("找不到这个文件夹了")}
          </p>
        )}

        {mode === "list" ? (
          <ul role="tree" aria-multiselectable>
            {rows.map(({ entry: e, depth }) => (
              <li
                key={e.path}
                role="treeitem"
                aria-expanded={e.type === "dir" && !e.deleted ? expanded.has(e.path) : undefined}
                {...itemProps(e)}
                className={`grid grid-cols-[minmax(0,1fr)_10rem_7.5rem_5rem] items-center gap-3 rounded-md px-3 py-1 text-sm ${shade(e)} ${e.deleted ? "opacity-55" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 18 }}>
                  {e.type === "dir" && !e.deleted ? (
                    <button
                      tabIndex={-1}
                      aria-label={expanded.has(e.path) ? t("收起") : t("展开")}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        toggle(e.path);
                      }}
                      className="rounded p-0.5 text-muted hover:text-fg"
                    >
                      {expanded.has(e.path) ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                  ) : (
                    <span className="flex w-4.5 shrink-0 justify-center">
                      {e.new && <NewDot label={e.new === "updated" ? t("有新版本，你还没打开过") : t("新文件，你还没打开过")} />}
                    </span>
                  )}
                  <span data-ql={e.path} className="flex shrink-0"><MarkedIcon e={e} marked={marked} className="size-4" /></span>
                  {renaming === e.path ? (
                    <RenameInput initial={e.name} onSubmit={(n) => onRename(e, n)} onCancel={onRenameCancel} className="flex-1 text-sm" />
                  ) : (
                    <span className={`truncate ${e.deleted ? "line-through" : ""} ${marked?.[e.path] || (showChanges && e.renamed_from) ? "max-w-[50%] shrink-0" : ""}`}>{e.name}</span>
                  )}
                  {showChanges && e.renamed_from && <WasNamed name={e.renamed_from} className="min-w-0 shrink-[100] truncate text-xs" />}
                  {marked?.[e.path] && <span className="min-w-0 shrink-[100] truncate text-xs text-muted">{marked[e.path].note}</span>}
                  {e.link && (
                    <span title={t("快捷方式，原文件在 {link}", { link: e.link })}>
                      <CornerUpRight className="size-3 shrink-0 text-muted" aria-label={t("快捷方式")} />
                    </span>
                  )}
                </span>
                <span className="min-w-0 overflow-hidden"><StatusBadges entry={e} showChanges={showChanges} /></span>
                <span className="truncate text-xs text-muted">{formatTime(e.mtime)}</span>
                <span className="text-right text-xs text-muted tabular-nums">{e.deleted ? "" : formatSize(e.size)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div ref={grid} role="listbox" aria-multiselectable className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 py-2">
            {rows.map(({ entry: e }) => (
              <div
                key={e.path}
                role="option"
                {...itemProps(e)}
                title={e.link ? t("{name}（快捷方式，原文件在 {link}）", { name: e.name, link: e.link }) : e.name}
                className={`flex flex-col items-center gap-1.5 rounded-lg p-2 ${shade(e)} ${e.deleted ? "opacity-55" : ""}`}
              >
                <div className="relative">
                  {e.type === "dir" ? (
                    <div data-ql={e.path} className="flex size-18 items-center justify-center"><MarkedIcon e={e} marked={marked} className="size-14" /></div>
                  ) : (
                    <Thumb path={e.path} name={e.name} mtime={e.mtime} size={72} iconClass="size-12" />
                  )}
                  {e.link && <CornerUpRight className="absolute bottom-0 left-0 size-4 rounded bg-panel p-0.5 text-muted shadow" aria-label={t("快捷方式")} />}
                  <IconMarks entry={e} showChanges={showChanges} />
                </div>
                {renaming === e.path ? (
                  <RenameInput initial={e.name} onSubmit={(n) => onRename(e, n)} onCancel={onRenameCancel} className="w-full text-center text-xs" />
                ) : (
                  <span className={`line-clamp-2 w-full text-center text-xs break-words ${e.deleted ? "line-through" : ""}`}>{e.name}</span>
                )}
                {showChanges && e.renamed_from && <WasNamed name={e.renamed_from} className="line-clamp-1 w-full text-center text-[11px] break-all" />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A file's or folder's icon; a marked folder's own. */
function MarkedIcon({ e, marked, className }: { e: Entry; marked: Props["marked"]; className: string }) {
  const Icon = marked?.[e.path]?.icon;
  return Icon ? <Icon className={`${className} shrink-0 text-type-folder`} /> : <FileIcon name={e.name} dir={e.type === "dir"} className={className} />;
}

/** What Canvas calls a folder you renamed, struck through. */
function WasNamed({ name, className }: { name: string; className: string }) {
  return <s title={t("Canvas 上叫“{name}”", { name })} className={`text-muted ${className}`}>{name}</s>;
}

function SortHeader({ label, k, sort, setSort, right }: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; desc: boolean };
  setSort: (s: { key: SortKey; desc: boolean }) => void;
  right?: boolean;
}) {
  const active = sort.key === k;
  return (
    <button
      onClick={() => setSort({ key: k, desc: active ? !sort.desc : k !== "name" })}
      className={`flex items-center gap-0.5 hover:text-fg ${right ? "justify-end" : ""} ${active ? "text-fg-soft" : ""}`}
    >
      {label}
      {active && (sort.desc ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />)}
    </button>
  );
}
