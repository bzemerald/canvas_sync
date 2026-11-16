// A list of search results (a smart folder's), with chips to see one kind of them.
import { useEffect, useState } from "react";
import type { Hit, Kind } from "../lib/api";
import { t } from "../lib/i18n";
import type { ViewMode } from "./FileBrowser";
import { HitBrowser } from "./HitBrowser";
import { KIND } from "./Result";

export function Results({ view, mode, results, asked, scope, showCourse, onOpen, onReveal, onMenu, onDelete, onCopy }: {
  view: unknown; // where they're shown (somewhere else: all kinds again)
  mode: ViewMode;
  query: string;
  results: { hits: Hit[]; error: string | null; loading: boolean };
  asked: boolean; // a search was typed, or is saved (a smart folder)
  scope?: { text: string; action: string; onAction: () => void } | null;
  onReveal: (hit: Hit) => void;
  showCourse: boolean;
  onOpen: (hit: Hit) => void;
  onMenu: (hits: Hit[], x: number, y: number) => void;
  onDelete: (hits: Hit[]) => void;
  onCopy: (hits: Hit[]) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const { hits, error, loading } = results;
  useEffect(() => setKind(null), [view]);
  const shown = kind ? hits.filter((h) => h.kind === kind) : hits;
  const counts: Partial<Record<Kind, number>> = {};
  for (const h of hits) counts[h.kind] = (counts[h.kind] ?? 0) + 1;

  const header = (
    <>
      {scope && (
        <p className="mb-2 flex items-center gap-2 px-2 text-xs text-muted">
          {scope.text}
          <button onClick={scope.onAction} className="text-accent hover:underline">{scope.action}</button>
        </p>
      )}
      {hits.length > 0 && Object.keys(counts).length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-2 text-xs">
          <Chip active={!kind} onClick={() => setKind(null)}>{t("All")} {hits.length}</Chip>
          {(Object.keys(KIND) as Kind[]).filter((k) => counts[k]).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{KIND[k].label} {counts[k]}</Chip>
          ))}
        </div>
      )}
      {error && <p className="px-2 py-6 text-sm text-danger whitespace-pre-wrap">{error}</p>}
      {!error && asked && !loading && shown.length === 0 && <p className="px-2 py-10 text-center text-sm text-muted">{t("No results")}</p>}
    </>
  );
  return <HitBrowser hits={shown} mode={mode} showCourse={showCourse} header={header} onOpen={onOpen} onReveal={onReveal} onMenu={onMenu} onDelete={onDelete} onCopy={onCopy} />;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 ${active ? "border-accent bg-accent text-on-accent" : "border-line text-fg-soft hover:bg-chip"}`}
    >
      {children}
    </button>
  );
}
