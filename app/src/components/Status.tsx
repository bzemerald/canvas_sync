import { useEffect, useState } from "react";
import { CloudOff, Pencil, RefreshCwOff, Trash2 } from "lucide-react";
import type { Entry } from "../lib/api";
import { t, tn } from "../lib/i18n";

const LABEL: Record<string, { text: string; className: string; hint: string }> = {
  modified: { text: t("Edited"), className: "bg-warn-soft text-warn", hint: t("You changed this file; syncing won't overwrite your changes") },
  missing: { text: t("Deleted"), className: "bg-danger-soft text-danger", hint: t("You deleted it; the next sync won't download it again") },
  ignored: { text: t("Deleted"), className: "bg-danger-soft text-danger", hint: t("You deleted it, so it isn't synced any more; you can restore it") },
  remote_deleted: { text: t("Gone from Canvas"), className: "bg-danger-soft text-danger", hint: t("Your instructor removed it from Canvas; your copy is kept") },
  untracked: { text: t("Not synced"), className: "bg-chip text-muted", hint: t("You stopped syncing it: it's your own file now, and updates on Canvas won't replace it") },
};
const SKIPPED_HINT = t("You deleted this folder or stopped syncing it: files Canvas adds here later won't download");
/** Why a file in a folder that isn't synced says so (one you stopped syncing says why itself). */
const skippedHint = (e: Entry) =>
  e.type === "dir" ? SKIPPED_HINT
    : e.link ? t("Its folder isn't synced any more; it's a shortcut, and the file it points to still syncs")
      : t("Its folder isn't synced any more: files Canvas adds here later won't download");
/** In a folder that isn't synced, and doesn't say so already (a file you deleted says that). */
const quietlySkipped = (e: Entry) => e.skipped && !e.states.includes("untracked") && !(e.type === "file" && e.deleted);
// Shown always: what Canvas did, and what isn't synced (that's how it is now, not a change to
// undo). The rest is what you did, shown only with Show modifications.
const ALWAYS = new Set(["remote_deleted", "untracked"]);

/** Badges for what changed. A file from Canvas that nobody touched shows nothing; what you
 * changed shows only when `showChanges` (but Not synced always). */
export function StatusBadges({ entry, showChanges }: { entry: Entry; showChanges: boolean }) {
  const states = [...new Set(entry.states.map((s) => (s === "missing" ? "ignored" : s)))]
    .filter((s) => showChanges || ALWAYS.has(s));
  return (
    <span className="flex gap-1">
      {states.map((s) =>
        LABEL[s] ? (
          <span key={s} title={LABEL[s].hint} className={`rounded px-1.5 py-px text-[11px] whitespace-nowrap ${LABEL[s].className}`}>
            {LABEL[s].text}
          </span>
        ) : null,
      )}
      {quietlySkipped(entry) && (
        <span title={skippedHint(entry)} className="rounded bg-chip px-1.5 py-px text-[11px] whitespace-nowrap text-muted">
          {t("Not synced")}
        </span>
      )}
      {entry.new === "updated" && (
        <span title={t("Canvas had a new version, now here too; you haven't opened it yet")} className="rounded bg-info-soft px-1.5 py-px text-[11px] whitespace-nowrap text-info">
          {t("Updated")}
        </span>
      )}
      {entry.type === "dir" && entry.new_inside > 0 && (
        <span title={t("Has new files you haven't opened yet")} className="rounded bg-selected px-1.5 py-px text-[11px] whitespace-nowrap text-accent">
          {tn("1 unread", "{n} unread", { n: entry.new_inside })}
        </span>
      )}
      {showChanges && <Tallies entry={entry} />}
    </span>
  );
}

/** A folder's count of what you deleted and changed below it: an icon and a number, small
 * enough to sit beside its other badges (the words are in the tooltip). */
function Tallies({ entry }: { entry: Entry }) {
  if (entry.type !== "dir") return null;
  return (
    <>
      {entry.deleted_inside > 0 && (
        <Pill icon={<Trash2 />} n={entry.deleted_inside} label={tn("Has 1 file you deleted", "Has {n} files you deleted", { n: entry.deleted_inside })} className="bg-danger text-on-accent" />
      )}
      {entry.modified_inside > 0 && (
        <Pill icon={<Pencil />} n={entry.modified_inside} label={tn("Has 1 file you changed", "Has {n} files you changed", { n: entry.modified_inside })} className="bg-warn text-on-accent" />
      )}
    </>
  );
}

export function Pill({ icon, n, label, className }: { icon?: React.ReactNode; n?: number; label: string; className: string }) {
  return (
    <span title={label} aria-label={label} className={`flex h-4 min-w-4 shrink-0 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] leading-none font-medium tabular-nums whitespace-nowrap [&>svg]:size-2.5 ${className}`}>
      {icon}
      {n !== undefined && (n > 99 ? "99+" : n)}
    </span>
  );
}

/** The icon view's marks, on the icon's corner: a folder's counts (new, and with `showChanges`
 * what you deleted and changed); a file's state as an icon; not synced, a sync icon struck out.
 * Hover says what each is. */
export function IconMarks({ entry, showChanges }: { entry: Entry; showChanges: boolean }) {
  const s = entry.states;
  const mine = (x: string) => showChanges && s.includes(x);
  const marks = entry.type === "dir" ? (
    <>
      {entry.new_inside > 0 && <Count n={entry.new_inside} label={t("Has new files you haven't opened yet")} />}
      {showChanges && <Tallies entry={entry} />}
      {quietlySkipped(entry) && <NotSynced label={skippedHint(entry)} />}
    </>
  ) : (
    <>
      {entry.new && <Pill label={entry.new === "updated" ? t("A new version you haven't opened yet") : t("New, and you haven't opened it yet")} className="bg-accent text-on-accent" />}
      {s.includes("remote_deleted") && <Pill icon={<CloudOff />} label={LABEL.remote_deleted.hint} className="bg-danger text-on-accent" />}
      {(mine("missing") || mine("ignored")) && <Pill icon={<Trash2 />} label={LABEL.ignored.hint} className="bg-danger text-on-accent" />}
      {mine("modified") && <Pill icon={<Pencil />} label={LABEL.modified.hint} className="bg-warn text-on-accent" />}
      {s.includes("untracked") ? <NotSynced label={LABEL.untracked.hint} /> : quietlySkipped(entry) && <NotSynced label={skippedHint(entry)} />}
    </>
  );
  return <span className="absolute -top-1 -right-1 flex gap-0.5 [&>*]:ring-2 [&>*]:ring-bg">{marks}</span>;
}

const NotSynced = ({ label }: { label: string }) => <Pill icon={<RefreshCwOff />} label={label} className="bg-muted text-on-accent" />;

/** How many new things there are. */
export function Count({ n, label }: { n: number; label: string }) {
  return (
    <span title={label} aria-label={label} className="min-w-4 shrink-0 rounded-full bg-accent px-1.5 text-center text-[10px] leading-4 font-medium text-on-accent">
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** Marks one new thing: arrived since you last looked, and you haven't opened it. */
export function NewDot({ label = t("New") }: { label?: string }) {
  return <span title={label} aria-label={label} className="size-1.5 shrink-0 rounded-full bg-accent" />;
}

/** Loading…, said only if it takes a while: usually the answer is in before anyone could read it,
 * and a flash of text would just make the page jump. It takes its place from the start. */
export function Loading({ className = "px-6 py-8 text-sm" }: { className?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(timer);
  }, []);
  return <p data-loading className={`${className} text-muted transition-opacity duration-200 ${slow ? "opacity-100" : "opacity-0"}`}>{t("Loading…")}</p>;
}
