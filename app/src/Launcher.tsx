// The ⌘⇧Space window: type, arrow, enter. Hides itself when it loses focus. What it finds is
// anything there is to go to (lib/find.ts): things that open elsewhere (a file, a tool, a web
// link, Canvas) open from here; the rest open in the main window, which comes forward.
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FoundList, type How, actionsFor, canvasUrl, moreKeys, useCatalog, useChosen, useFound } from "./components/Found";
import { isMac } from "./components/Result";
import * as api from "./lib/api";
import type { Hit } from "./lib/api";
import type { Found } from "./lib/find";
import { useLoaded } from "./lib/useLoaded";
import { useSearch } from "./lib/useSearch";
import { friendly } from "./lib/errors";
import { t } from "./lib/i18n";
import { type Thing, isView, thingKey, thingOf, thingOfHit } from "./lib/things";

const mod = isMac ? "⌘" : "Ctrl";
const NO_COURSES: api.Course[] = [];

export function Launcher() {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(0); // times it came forward: what it knows is loaded again
  const input = useRef<HTMLInputElement>(null);
  const { hits, error, loading } = useSearch(query, (q) => api.search(q, { limit: 40 }));
  const courses = useLoaded("courses", api.courses, [shown]).value ?? NO_COURSES; // (their icons)
  const { catalog, usage, names } = useCatalog([shown], courses);
  const actions = useMemo(() => actionsFor(names, [{ id: "main", label: t("打开主窗口"), names: [t("打开主窗口"), t("主窗口")] }]), [names]);
  const { results, lately, due, listed, first, nothing } = useFound(query, catalog, usage, hits, actions);
  // The first is chosen, whatever came in last (names as you type, the index a moment later).
  const { value, choose, list } = useChosen(query, listed, first);

  // Each time the window comes back, start from a selected query so typing replaces it.
  useEffect(() => {
    const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        setShown((n) => n + 1);
        input.current?.focus();
        input.current?.select();
      }
    });
    return () => void off.then((f) => f());
  }, []);

  const hide = () => invoke("hide_launcher");
  /** In the main window, which comes forward (it notes it was opened). */
  const there = async (thing: Thing) => {
    await emitTo("main", "open-thing", { thing, query });
    await invoke("show_main");
  };
  const done = async (key: string) => {
    api.noteOpened(key, query);
    await hide();
  };

  const openHit = async (hit: Hit, how: How) => {
    const thing = thingOfHit(hit);
    if (how === "canvas") return void (await api.openCanvas(hit), await done(thing ? thingKey(thing) : ""));
    if (how === "reveal" && hit.path) {
      await emitTo("main", "show-path", { path: hit.path }); // its folder, in the app (not Finder)
      return void (await invoke("show_main"));
    }
    if (thing && thing.type !== "file") return there(thing); // read it in the app, not on Canvas
    await api.openHit(hit);
    await done(thing ? thingKey(thing) : "");
  };

  const open = async (f: Found | undefined, how: How) => {
    if (!f) return;
    if (f.type === "hit") return openHit(f.hit, how);
    if (f.type === "action") {
      api.noteOpened(f.key, query);
      if (f.action.id === "main") return void (await invoke("show_main"));
      await emitTo("main", "run-action", { id: f.action.id });
      return void (await (f.action.id.startsWith("sync") ? hide() : invoke("show_main")));
    }
    const e = f.entry;
    if (how === "canvas") {
      const url = canvasUrl(e);
      return void (url && (await api.openUrl(url), await done(f.key)));
    }
    if (how === "reveal" && e.type === "file") {
      await emitTo("main", "show-path", { path: e.path });
      return void (await invoke("show_main"));
    }
    if (e.type === "file") await api.openPath(e.path);
    else if (e.type === "link") await api.openExternal(e.url);
    else if (e.type === "tool") await api.launch(e.course, { tool_id: e.tool });
    else if (isView(e, "canvas")) await api.openUrl(`/courses/${e.course}`);
    else return there(thingOf(e));
    await done(f.key);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (moreKeys(e, () => listed.get(value), (f, how) => void open(f, how))) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else void hide();
    } else if (e.key.toLowerCase() === "o" && primary) {
      e.preventDefault();
      void invoke("show_main");
    }
  };

  return (
    <div className="h-screen p-3">
      <Command
        shouldFilter={false}
        loop
        value={value}
        onValueChange={choose}
        onKeyDown={onKeyDown}
        className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-line px-4" data-tauri-drag-region>
          <Search className="size-5 shrink-0 text-muted" aria-hidden />
          <Command.Input
            ref={input}
            autoFocus
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            onValueChange={setQuery}
            placeholder={t("搜索课程内容… 例如 221 mt、cs70 hw3 sol、期中")}
            className="h-14 w-full bg-transparent text-lg text-fg outline-none placeholder:text-muted"
          />
          {loading && <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />}
        </div>

        <Command.List ref={list} className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && <p className="px-3 py-6 text-sm text-danger whitespace-pre-wrap">{friendly(error)}</p>}
          {!error && query.trim() && !loading && nothing && (
            <Command.Empty className="px-3 py-10 text-center text-sm text-muted">{t("没有结果")}</Command.Empty>
          )}
          {!error && !query.trim() && !lately.length && !due.length && <Tips />}
          <FoundList results={results} recent={lately} due={due} courses={courses} names={names} onOpen={(f) => void open(f, "open")} />
        </Command.List>

        <footer className="flex gap-4 border-t border-line px-4 py-2 text-xs text-muted">
          <span><Key>↵</Key> {t("打开")}</span>
          <span><Key>{mod}↵</Key> {t("在文件夹中显示")}</span>
          <span><Key>{mod}⇧↵</Key> {t("在 Canvas 中打开")}</span>
          <span className="ml-auto"><Key>{mod}O</Key> {t("主窗口")}</span>
          <span><Key>esc</Key> {t("关闭")}</span>
        </footer>
      </Command>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-chip px-1 font-sans text-[11px] text-fg-soft">{children}</kbd>;
}

function Tips() {
  const examples: [string, string][] = [
    ["221 mt", t("MATH 221 里和 midterm 有关的一切")],
    ["cs70 hw3 sol", t("CS 70 第 3 次作业的答案")],
    [t("期中"), t("所有课程的期中相关内容")],
    ["data100 late", t("Data 100 的迟交政策")],
  ];
  return (
    <div className="px-3 py-4 text-sm text-muted">
      <p className="mb-3">{t("课程名 + 关键词，缩写也行：")}</p>
      <ul className="space-y-1.5">
        {examples.map(([q, what]) => (
          <li key={q} className="flex gap-3">
            <code className="w-32 shrink-0 text-fg-soft">{q}</code>
            <span>{what}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
