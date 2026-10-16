import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import type { Course, Kind, PinnedItem, SmartFolder } from "../lib/api";
import { Button, Dialog } from "./Dialog";
import { KIND } from "./Result";
import { t } from "../lib/i18n";

/** Create or edit a saved search. Shows how many items it matches as you type. */
export function SmartFolderDialog({ initial, preset, courses, onClose, onSaved }: {
  initial: SmartFolder | null; // the folder being edited; null: a new one
  preset?: SmartFolder | null; // a new one's starting values (e.g. limited to a course)
  courses: Course[];
  onClose: () => void;
  onSaved: (pinned: PinnedItem[], name: string) => void;
}) {
  const start = initial ?? preset;
  const [name, setName] = useState(start?.name ?? "");
  const [query, setQuery] = useState(start?.query ?? "");
  const [picked, setPicked] = useState<Set<number>>(new Set(start?.courses ?? []));
  const [kinds, setKinds] = useState<Set<Kind>>(new Set(start?.kinds ?? []));
  const [content, setContent] = useState(start?.content ?? false);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const folder: SmartFolder = useMemo(
    () => ({ name: name.trim(), query: query.trim(), courses: [...picked], kinds: [...kinds], content }),
    [name, query, picked, kinds, content],
  );

  useEffect(() => {
    if (!folder.query && !folder.courses.length && !folder.kinds.length) return setCount(null);
    const t = setTimeout(() => {
      api.search(folder.query, { courses: folder.courses, kinds: folder.kinds, namesOnly: !folder.content, limit: 500 })
        .then((h) => setCount(h.length), () => setCount(null));
    }, 200);
    return () => clearTimeout(t);
  }, [folder]);

  const save = async () => {
    try {
      onSaved(await api.saveSmartFolder(folder, initial?.name), folder.name);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };

  const byTerm = useMemo(() => {
    const m = new Map<string, Course[]>();
    for (const c of courses) {
      const term = c.term_label ?? t("无学期");
      m.set(term, [...(m.get(term) ?? []), c]);
    }
    return [...m.entries()];
  }, [courses]);

  const nothing = !folder.query && !folder.courses.length && !folder.kinds.length;
  return (
    <Dialog
      title={initial ? t("编辑智能文件夹") : t("新建智能文件夹")}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted">{count === null ? "" : t("现在匹配 {n} 项", { n: count >= 500 ? "500+" : count })}</span>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button primary disabled={!folder.name || nothing} onClick={save}>{t("保存")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("名称")}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("例如：期中 1 复习")}
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("搜索内容（和搜索框一样，可以用课程名和缩写）")}</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("例如：mt1、hw sol、期中")}
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent" />
        </label>
        <label className="-mt-2 flex items-start gap-2 text-xs text-fg-soft">
            <input type="checkbox" className="mt-0.5" checked={content} onChange={(e) => setContent(e.target.checked)} />
            <span>
              {t("也匹配正文")}
              <span className="block text-muted">{t("不勾选时只看文件名、标题和所在文件夹，比如 “mt” 只收进期中相关的材料，不收提到期中的讲义。")}</span>
            </span>
        </label>
        <fieldset>
          <legend className="mb-1 text-xs text-muted">{t("类型（不选 = 全部）")}</legend>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(KIND) as Kind[]).map((k) => (
              <button key={k} onClick={() => setKinds(toggle(kinds, k))}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${kinds.has(k) ? "border-accent bg-accent text-on-accent" : "border-line text-fg-soft hover:bg-chip"}`}>
                {KIND[k].label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-xs text-muted">{t("课程（不选 = 全部）")}</legend>
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-line p-2">
            {byTerm.map(([term, list]) => (
              <div key={term}>
                <div className="text-[11px] text-muted">{term}</div>
                {list.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 py-0.5">
                    <input type="checkbox" checked={picked.has(c.id)} onChange={() => setPicked(toggle(picked, c.id))} />
                    <span className="truncate">{c.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </fieldset>
        {error && <p className="text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
