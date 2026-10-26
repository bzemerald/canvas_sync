// Which courses sync, ticked in a list of all your courses on Canvas, by term. Before the first
// sync (Canvas leaves most past courses "active", so all of them would come), and in 设置.
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type { CourseChoice, SyncState } from "../lib/api";
import { CourseIcon } from "../lib/courseIcons";
import { friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { currentCourses, ongoing, termRank } from "../lib/terms";
import { Button } from "./Dialog";
import { LanguagePicker } from "./LanguagePicker";

interface Term {
  name: string | null;
  start: number | null; // (the earliest of its courses' terms' starts)
  courses: CourseChoice[];
  now: boolean; // going on, or still to come
}

/** Newest term first: by the terms' dates when both have them, else by their names. */
function terms(courses: CourseChoice[]): Term[] {
  const by = new Map<string, Term>();
  for (const c of courses) {
    const key = c.term ?? "";
    const term = by.get(key) ?? { name: c.term, start: null, courses: [], now: false };
    const start = c.term_start ? Date.parse(c.term_start) : null;
    if (start !== null && (term.start === null || start < term.start)) term.start = start;
    term.courses.push(c);
    term.now ||= !!ongoing(c);
    by.set(key, term);
  }
  return [...by.values()]
    .map((x) => ({ ...x, courses: x.courses.sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => {
      if (!a.name !== !b.name) return a.name ? -1 : 1; // (no term: last)
      if (a.start !== null && b.start !== null && a.start !== b.start) return b.start - a.start;
      return termRank(b.name) - termRank(a.name) || (a.name ?? "").localeCompare(b.name ?? "");
    });
}

export function ChooseCourses({ submitLabel, onDone, onCancel }: {
  submitLabel: string;
  onDone: (sync: SyncState, added: number[]) => void; // `added`: chosen, not syncing before
  onCancel?: () => void;
}) {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.courseChoice>> | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    setList(null);
    api.courseChoice().then((got) => {
      setList(got);
      // Chosen before: as it is; else what's going on now.
      setPicked(new Set(got.chosen ? got.courses.filter((c) => c.syncing).map((c) => c.id) : currentCourses(got.courses)));
    }, (e) => setError(friendly((e as Error).message)));
  };
  useEffect(load, []);
  const grouped = useMemo(() => terms(list?.courses ?? []), [list]);

  const toggle = (ids: number[], on: boolean) =>
    setPicked((was) => {
      const next = new Set(was);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  const save = async () => {
    if (!list) return;
    setBusy(true);
    setError(null);
    const all = list.courses.map((c) => c.id);
    try {
      const sync = await api.chooseCourses(all.filter((id) => picked.has(id)), all.filter((id) => !picked.has(id)));
      onDone(sync, list.courses.filter((c) => picked.has(c.id) && !c.syncing).map((c) => c.id));
    } catch (e) {
      setError(friendly((e as Error).message));
      setBusy(false);
    }
  };

  return (
    <div className="text-sm">
      {!list && !error && <p className="py-8 text-center text-muted">{t("正在读取 Canvas 上的课程…")}</p>}
      {list && list.courses.length === 0 && <p className="py-8 text-center text-muted">{t("Canvas 上没有找到你的课程。")}</p>}
      {list && list.courses.length > 0 && (
        <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-line">
          {grouped.map((term) => {
            const ids = term.courses.map((c) => c.id);
            const on = ids.filter((id) => picked.has(id)).length;
            return (
              <div key={term.name ?? ""} className="border-b border-line last:border-b-0">
                <label className="sticky top-0 z-10 flex items-center gap-2.5 bg-panel px-3 py-2 font-medium">
                  <Check checked={on === ids.length} mixed={on > 0 && on < ids.length} onChange={(v) => toggle(ids, v)} />
                  <span className="truncate">{term.name ?? t("没有学期")}</span>
                  {term.now && <span className="shrink-0 rounded bg-selected px-1.5 py-px text-[11px] font-normal text-accent">{t("进行中")}</span>}
                  <span className="ml-auto shrink-0 text-xs font-normal text-muted">{t("{on}/{n} 门", { on, n: ids.length })}</span>
                </label>
                {term.courses.map((c) => (
                  <label key={c.id} className="flex items-center gap-2.5 py-1.5 pr-3 pl-8 hover:bg-chip">
                    <Check checked={picked.has(c.id)} onChange={(v) => toggle([c.id], v)} />
                    <CourseIcon course={{ ...c, display_code: c.label }} size={15} />
                    <span className="shrink-0">{c.label}</span>
                    {c.name !== c.label && <span className="min-w-0 truncate text-muted">{c.name}</span>}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {list && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {list.select === "active"
            ? t("没勾选的课不会下载。以后 Canvas 上新加的课程会自动同步；随时可以在设置里重新选。")
            : t("没勾选的课不会下载。以后你在 Canvas 上收藏的新课程会自动同步；随时可以在设置里重新选。")}
        </p>
      )}
      {error && (
        <p className="mt-3 text-danger">
          {error}
          {!list && <button onClick={load} className="ml-2 text-accent hover:underline">{t("重试")}</button>}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 pt-4">
        {list && <span className="mr-auto text-xs text-muted">{t("已选 {n} 门课", { n: picked.size })}</span>}
        {onCancel && <Button onClick={onCancel}>{t("取消")}</Button>}
        <Button primary disabled={!list || busy || picked.size === 0} onClick={() => void save()}>{submitLabel}</Button>
      </div>
    </div>
  );
}

function Check({ checked, mixed, onChange }: { checked: boolean; mixed?: boolean; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="shrink-0 accent-accent" />;
}

/** The whole window, after signing in to a folder that has never synced. */
export function ChooseCoursesPage({ onDone }: { onDone: () => void }) {
  return (
    <div data-tauri-drag-region className="flex h-screen items-center justify-center overflow-y-auto bg-bg p-8 text-fg">
      <div className="w-full max-w-lg">
        <h1 className="mb-1 text-xl font-semibold">{t("选择要同步的课程")}</h1>
        <p className="mb-5 text-sm text-muted">{t("Canvas 上往往还挂着以前学期的课。已经勾好了正在进行的课程，看看对不对。")}</p>
        <div className="rounded-xl border border-line bg-panel p-5">
          <ChooseCourses submitLabel={t("开始同步")} onDone={onDone} />
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 text-xs text-muted">
          <span>{t("语言")}</span>
          <LanguagePicker />
        </div>
      </div>
    </div>
  );
}
