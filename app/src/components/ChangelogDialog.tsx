import { releases } from "../lib/changelog";
import { t } from "../lib/i18n";
import { Dialog } from "./Dialog";

/** What's new in each version (CHANGELOG.md). `since`: the version updated from; what came after
 * it is marked new. */
export function ChangelogDialog({ since, onClose }: { since?: string; onClose: () => void }) {
  const all = releases();
  const fresh = since ? all.findIndex((r) => r.version === since) : 0; // (how many are new)
  return (
    <Dialog title={t("Changelog")} onClose={onClose}>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pb-3">
        {all.map((r, i) => (
          <section key={r.version}>
            <h3 className="flex items-baseline gap-2 font-medium">
              <span className="tabular-nums">{r.version}</span>
              {r.date && <span className="text-xs font-normal text-muted tabular-nums">{r.date}</span>}
              {i < fresh && <span className="rounded bg-selected px-1.5 text-xs font-normal text-accent">{t("New@@version")}</span>}
            </h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-fg-soft">
              {r.items.map((item, j) => <li key={j}>{item}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
