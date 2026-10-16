// The ⌘⇧Space window: type, arrow, enter. Hides itself when it loses focus.
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContentDivider, ResultBody, fileManager, firstContentMatch, hitKey, isMac } from "./components/Result";
import { openCanvas, openHit, search, type Hit } from "./lib/api";
import { useSearch } from "./lib/useSearch";
import { friendly } from "./lib/errors";
import { t } from "./lib/i18n";

const mod = isMac ? "⌘" : "Ctrl";

export function Launcher() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { hits, error, loading } = useSearch(query, (q) => search(q, { limit: 30 }));
  const byKey = useMemo(() => new Map(hits.map((h) => [hitKey(h), h])), [hits]);

  // Each time the window comes back, start from a selected query so typing replaces it.
  useEffect(() => {
    const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        input.current?.focus();
        input.current?.select();
      }
    });
    return () => void off.then((f) => f());
  }, []);

  const hide = () => invoke("hide_launcher");
  const act = async (hit: Hit | undefined, how: "open" | "reveal" | "canvas") => {
    if (!hit) return;
    if (how === "canvas") await openCanvas(hit);
    else if (how === "open" && hit.kind !== "file" && hit.doc_id) {
      // Read it in the app, not on the Canvas website.
      await emitTo("main", "open-doc", { course_id: hit.course_id, kind: hit.kind, doc_id: hit.doc_id });
      await invoke("show_main");
      return;
    } else await openHit(hit, how === "reveal");
    await hide();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else void hide();
    } else if (e.key === "Enter" && primary) {
      e.preventDefault();
      void act(byKey.get(selected), e.shiftKey ? "canvas" : "reveal");
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
        value={selected}
        onValueChange={setSelected}
        onKeyDown={onKeyDown}
        className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-line px-4" data-tauri-drag-region>
          <Search className="size-5 shrink-0 text-muted" aria-hidden />
          <Command.Input
            ref={input}
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t("搜索课程内容… 例如 221 mt、cs70 hw3 sol、期中")}
            className="h-14 w-full bg-transparent text-lg text-fg outline-none placeholder:text-muted"
          />
          {loading && <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />}
        </div>

        <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && <p className="px-3 py-6 text-sm text-danger whitespace-pre-wrap">{friendly(error)}</p>}
          {!error && query.trim() && !loading && hits.length === 0 && (
            <Command.Empty className="px-3 py-10 text-center text-sm text-muted">{t("没有结果")}</Command.Empty>
          )}
          {!error && !query.trim() && <Tips />}
          {hits.map((h, i) => [
            i === firstContentMatch(hits) && <ContentDivider key="divider" />,
            <Command.Item
              key={hitKey(h)}
              value={hitKey(h)}
              onSelect={() => void act(h, "open")}
              className="cursor-default rounded-lg px-3 py-2 data-[selected=true]:bg-selected"
            >
              <ResultBody hit={h} />
            </Command.Item>,
          ])}
        </Command.List>

        <footer className="flex gap-4 border-t border-line px-4 py-2 text-xs text-muted">
          <span><Key>↵</Key> {t("打开")}</span>
          <span><Key>{mod}↵</Key> {t("在 {app} 中显示", { app: fileManager })}</span>
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
