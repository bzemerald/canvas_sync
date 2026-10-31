// The ⌘⇧Space window: type, arrow, enter. Hides itself when it loses focus. What it finds is
// anything there is to go to (lib/find.ts): things that open elsewhere (a file, a tool, a web
// link, Canvas) open from here; the rest open in the main window, which comes forward.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CompletionGhost, FoundList, type How, ReadingBar, actionsFor, canvasUrl, completion, moreKeys, useCatalog, useChosen, useFinding,
} from "./components/Found";
import { isMac } from "./components/Result";
import * as api from "./lib/api";
import type { Hit } from "./lib/api";
import type { Found } from "./lib/find";
import { useLoaded } from "./lib/useLoaded";
import { friendly } from "./lib/errors";
import { lang, t } from "./lib/i18n";
import { type Example, examples, seeded } from "./lib/examples";
import { termRank } from "./lib/terms";
import { type Thing, isView, thingKey, thingOf, thingOfHit } from "./lib/things";

const mod = isMac ? "⌘" : "Ctrl";
const NO_COURSES: api.Course[] = [];

export function Launcher() {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(0); // times it came forward: what it knows is loaded again
  const input = useRef<HTMLInputElement>(null);
  const courses = useLoaded("courses", api.courses, [shown]).value ?? NO_COURSES; // (their icons)
  const { catalog, vocab, usage, names } = useCatalog([shown], courses);
  const actions = useMemo(() => actionsFor(names, [{ id: "main", label: t("打开主窗口"), names: [t("打开主窗口"), t("主窗口")] }]), [names]);
  const { reading, results, lately, due, listed, first, nothing, error, loading, words } = useFinding(query, catalog, vocab, usage, actions);
  // Searching, said only when it takes a while (it mostly answers at once: a dot would only flash).
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(timer);
  }, [loading]);
  // The first is chosen, whatever came in last (names as you type, the index a moment later).
  const { value, choose, list } = useChosen(query, listed, first);
  const completed = completion(reading, listed.get(value), listed.values(), words); // what ⇥ would make of the query
  // Ways to search, from your current courses: new ones for each time the window comes up, made
  // as it goes away (and once, when what they're made from is first in), so nothing changes while
  // it's up, nor as it comes up and what it knows reloads.
  const round = useRef(0);
  const made = useRef({ catalog, vocab, courses });
  made.current = { catalog, vocab, courses };
  const [ahead, setAhead] = useState<{ tips: Example[]; pick: number } | null>(null);
  const makeTips = () => {
    const { catalog, vocab, courses } = made.current;
    if (!catalog) return null;
    // (Of the newest term you sync: what you're taking now.)
    const synced = courses.filter((c) => !c.hidden && !c.excluded);
    const newest = Math.max(0, ...synced.map((c) => termRank(c.term)));
    const current = synced.filter((c) => termRank(c.term) === newest).map((c) => c.id);
    const n = ++round.current;
    const tips = examples(catalog, vocab, current, Date.now(), lang, 6, seeded(n));
    return { tips, pick: tips.length ? n % tips.length : 0 };
  };
  useEffect(() => {
    if (!ahead && catalog && courses.length) setAhead(makeTips());
  }, [catalog, courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const tips = ahead?.tips ?? [];

  // The main window searching something here (its "search all courses").
  useEffect(() => {
    const off = listen<{ query: string }>("launcher-query", ({ payload }) => setQuery(payload.query));
    return () => void off.then((f) => f());
  }, []);

  // Each time the window comes back, start from a selected query so typing replaces it.
  useEffect(() => {
    const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        setShown((n) => n + 1);
        input.current?.focus();
        input.current?.select();
      } else setAhead((was) => makeTips() ?? was); // (for next time: it's hidden now)
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
    if (moreKeys(e, () => listed.get(value), (f, how) => void open(f, how), () => completed, setQuery)) return;
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
    // Anything that isn't a control drags the window (Tauri leaves buttons, inputs, options alone).
    <div className="h-screen p-3" data-tauri-drag-region="deep">
      <Command
        shouldFilter={false}
        loop
        value={value}
        onValueChange={choose}
        onKeyDown={onKeyDown}
        className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
      >
        <div className="border-b border-line">
          <div className="flex items-center gap-3 px-4">
            <Search className="size-5 shrink-0 text-muted" aria-hidden />
            <div className="relative min-w-0 flex-1">
              <Command.Input
                ref={input}
                autoFocus
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={query}
                onValueChange={setQuery}
                onMouseDown={dragPastText}
                placeholder={tips.length
                  ? t("搜索课程内容… 例如 {example}", { example: tips[ahead!.pick].query })
                  : t("搜索课程内容… 例如 221 mt、cs70 hw3 sol、期中")}
                className="h-14 w-full bg-transparent text-lg text-fg outline-none placeholder:text-muted"
              />
              <CompletionGhost query={query} completion={completed} className="text-lg" />
            </div>
            {loading && slow && <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />}
          </div>
          <ReadingBar reading={reading} names={names} courses={courses} onQuery={setQuery} className="-mt-1 px-4 pb-2.5 pl-12" />
        </div>

        <Command.List ref={list} onMouseDown={onScrollbar} className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && <p className="px-3 py-6 text-sm text-danger whitespace-pre-wrap">{friendly(error)}</p>}
          {!error && query.trim() && !loading && nothing && (
            <Command.Empty className="px-3 py-10 text-center text-sm text-muted">{t("没有结果")}</Command.Empty>
          )}
          {!error && !query.trim() && !lately.length && !due.length && <Tips examples={tips} onQuery={(q) => { setQuery(q); input.current?.focus(); }} />}
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

/** A press in the search box well past what's typed (about three characters on) drags the window, as the
 * rest of it does; nearer, it's the box's own (the caret, selecting). */
function dragPastText(e: React.MouseEvent<HTMLInputElement>) {
  const box = e.currentTarget;
  if (e.button !== 0 || e.detail > 1) return;
  const style = getComputedStyle(box);
  const ctx = (measure ??= document.createElement("canvas").getContext("2d")!);
  ctx.font = style.font;
  const end = box.getBoundingClientRect().left + parseFloat(style.paddingLeft) + ctx.measureText(box.value).width - box.scrollLeft;
  if (e.clientX < end + 3 * ctx.measureText("0").width) return;
  e.preventDefault(); // keep the caret where it is
  box.focus();
  void getCurrentWindow().startDragging();
}
let measure: CanvasRenderingContext2D | undefined;

/** A press on the list's scrollbar scrolls it, rather than dragging the window. */
function onScrollbar(e: React.MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (e.clientX >= el.getBoundingClientRect().left + el.clientLeft + el.clientWidth) e.stopPropagation();
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-chip px-1 font-sans text-[11px] text-fg-soft">{children}</kbd>;
}

// Until your courses' own are known (examples.ts), or if they give none.
const SOME: Example[] = [
  ["221 mt", t("MATH 221 里和 midterm 有关的一切")],
  ["cs70 hw3 sol", t("CS 70 第 3 次作业的答案")],
  ["53 ps 3", t("MATH 53 的第 3 次作业，叫 HW 3 还是 Problem Set 3 都行")],
  [t("cs70 本周截止"), t("CS 70 这周要交的作业")],
  [t("未交"), t("所有还没交的作业")],
  [t("期中"), t("所有课程的期中相关内容")],
].map(([query, what]) => ({ query, what, shows: "number", course: 0 }));

/** Ways to search, each an example from your courses: clicking one searches it. */
function Tips({ examples, onQuery }: { examples: Example[]; onQuery: (q: string) => void }) {
  return (
    <div className="px-3 py-4 text-sm text-muted">
      <p className="mb-3">{t("课程名、类型、时间或提交状态，加上关键词；缩写和拼错也行：")}</p>
      <ul className="space-y-1.5">
        {(examples.length ? examples : SOME).map(({ query, what }) => (
          <li key={query} className="flex gap-3">
            <button onClick={() => onQuery(query)} className="w-40 shrink-0 truncate text-left font-mono text-fg-soft hover:text-accent">{query}</button>
            <span className="min-w-0 truncate">{what}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
