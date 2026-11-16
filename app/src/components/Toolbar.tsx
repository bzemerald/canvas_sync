// The toolbar's pieces: where you are (the breadcrumb, a smart folder's title), the search box, a
// button.
import { ChevronRight, Search, Sparkles } from "lucide-react";
import type { Course } from "../lib/api";
import { t } from "../lib/i18n";
import { type ThingOf, folderTitle } from "../lib/things";
import { CompletionGhost } from "./Found";
import { KIND } from "./Result";

export function SearchInput({ inputRef, value, onChange, placeholder, compact, autoFocus, completion }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  completion?: string | null; // what ⇥ would make of it: shown faint, with the key
  onChange: (v: string) => void;
  placeholder: string;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={`flex items-center border border-line bg-panel ${compact ? "w-56 shrink-0 gap-2 rounded-lg px-2.5 focus-within:border-accent" : "gap-3 rounded-xl px-4"}`}>
      <Search className="size-4 shrink-0 text-muted" aria-hidden />
      <div className="relative min-w-0 flex-1">
        <input
          ref={inputRef}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
            // Cleared and left: the keys go to the page (its list), as before searching.
            onChange("");
            e.currentTarget.blur();
            requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-keys]")?.focus());
          }}
          // A query ("mt", "hw3 sol"), not prose: no autocorrect or capitals.
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={placeholder}
          className={`w-full bg-transparent outline-none placeholder:text-muted ${compact ? "h-7 text-sm" : "h-11"}`}
        />
        <CompletionGhost query={value} completion={completion ?? null} className={compact ? "text-sm" : ""} />
      </div>
    </div>
  );
}

/** Where you are. In a course it starts at the course (its name, not where its files live). */
export function Breadcrumb({ path, root = { path: "", label: t("All files") }, inline, onGo, onRootMenu }: {
  path: string;
  root?: { path: string; label: string; icon?: React.ReactNode };
  inline?: string; // a folder shown as the root itself (a course's Files, in Files): not a step
  onGo: (p: string) => void;
  onRootMenu?: (x: number, y: number) => void; // the root, right-clicked
}) {
  const rest = path.slice(root.path.length).replace(/^\//, "");
  const prefix = root.path ? root.path + "/" : "";
  const parts = (rest ? rest.split("/") : []).map((_, i, all) => prefix + all.slice(0, i + 1).join("/")).map((p) => ({ name: folderTitle(p), path: p }))
    .filter((p) => p.path !== inline);
  return (
    <nav className="flex min-w-0 items-center gap-0.5 text-sm" aria-label={t("Location")}>
      <button onClick={() => onGo(root.path)} onContextMenu={onRootMenu && ((e) => (e.preventDefault(), onRootMenu(e.clientX, e.clientY)))} className={`flex shrink-0 items-center gap-1.5 truncate rounded px-1.5 py-0.5 hover:bg-chip ${parts.length ? "text-muted" : "font-medium"}`}>
        {root.icon}
        {root.label}
      </button>
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight className="size-3.5 shrink-0 text-muted" />
          <button
            onClick={() => onGo(p.path)}
            className={`truncate rounded px-1.5 py-0.5 hover:bg-chip ${i === parts.length - 1 ? "font-medium" : "text-muted"}`}
          >
            {p.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

export function SmartTitle({ folder, name, courses }: { folder: ThingOf<"search">; name: string; courses: Course[] }) {
  const names = folder.courses.map((id) => courses.find((c) => c.id === id)?.label ?? `#${id}`);
  const bits = [
    folder.query && `“${folder.query}”`,
    names.length ? names.join(t(", ")) : t("All courses@@search"),
    folder.kinds.length ? folder.kinds.map((k) => KIND[k].label).join(t(", ")) : "",
    folder.content ? t("Includes text inside") : t("Names only"),
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium"><Sparkles className="size-4 text-accent" />{name}</span>
      <span className="truncate text-xs text-muted">{bits.join(" · ")}</span>
    </div>
  );
}

export function ToolButton({ title, onClick, disabled, pressed, children }: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-1.5 disabled:opacity-30 ${pressed ? "bg-chip text-fg" : "text-muted hover:bg-chip hover:text-fg"}`}
    >
      {children}
    </button>
  );
}
