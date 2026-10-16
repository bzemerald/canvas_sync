// Picking courses by typing: chips for the ones picked, and a list of matches for what's typed
// (code, name, term). Arrows and Enter pick; Backspace in an empty box drops the last chip.
import { X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Course } from "../lib/api";
import { CourseIcon } from "../lib/courseIcons";
import { t } from "../lib/i18n";
import { termRank } from "../lib/terms";

export function CoursePicker({ courses, picked, onChange, placeholder }: {
  courses: Course[];
  picked: number[];
  onChange: (ids: number[]) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return courses
      .filter((c) => !picked.includes(c.id) && !c.hidden)
      .filter((c) => {
        const text = `${c.label} ${c.display_code} ${c.code} ${c.name} ${c.term_label ?? ""}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .sort((a, b) => termRank(b.term) - termRank(a.term) || a.label.localeCompare(b.label));
  }, [courses, picked, query]);

  const add = (c: Course) => {
    onChange([...picked, c.id]);
    setQuery("");
    setActive(0);
    input.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, matches.length - 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" && matches[active]) add(matches[active]);
    else if (e.key === "Backspace" && !query && picked.length) onChange(picked.slice(0, -1));
    else if (e.key === "Escape" && open) setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation(); // (Escape would close the dialog)
  };

  return (
    <div>
      <div
        onClick={() => input.current?.focus()}
        className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 focus-within:border-accent"
      >
        {picked.map((id) => {
          const c = byId.get(id);
          return (
            <span key={id} className="flex items-center gap-1 rounded-md bg-chip py-0.5 pr-1 pl-1.5 text-xs">
              {c && <CourseIcon course={c} size={13} />}
              {c?.label ?? t("课程 #{id}", { id })}
              <button
                aria-label={t("去掉")}
                onClick={(e) => (e.stopPropagation(), onChange(picked.filter((x) => x !== id)))}
                className="rounded p-0.5 text-muted hover:bg-line hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          role="combobox"
          aria-expanded={open}
          value={query}
          onChange={(e) => (setQuery(e.target.value), setActive(0), setOpen(true))}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder={picked.length ? "" : (placeholder ?? t("输入课程名搜索…"))}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-none"
        />
      </div>
      {open && (
        <ul role="listbox" className="mt-1 max-h-48 overflow-y-auto rounded-md border border-line bg-panel p-1">
          {matches.length === 0 && <li className="px-2 py-1.5 text-xs text-muted">{t("没有匹配的课程")}</li>}
          {matches.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === active}>
              <button
                onMouseDown={(e) => e.preventDefault()} // (keep the focus in the box)
                onMouseEnter={() => setActive(i)}
                onClick={() => add(c)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${i === active ? "bg-selected" : ""}`}
              >
                <CourseIcon course={c} size={14} />
                <span className="truncate">{c.label}</span>
                <span className="ml-auto shrink-0 truncate text-xs text-muted">{c.term_label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
