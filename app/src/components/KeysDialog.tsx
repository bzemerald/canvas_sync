import { t } from "../lib/i18n";
import { copyName, isMac, shortcut, trashName } from "../lib/keys";
import { keysLabel, useLauncherKeys } from "../lib/launcherKeys";
import { Button, Dialog } from "./Dialog";

/** Every keyboard shortcut, by where it works (⌘/ shows it). */
export function KeysDialog({ onClose }: { onClose: () => void }) {
  const launcher = useLauncherKeys();
  const groups: [string, [string, string][]][] = [
    [t("Anywhere"), [
      [t("Search window"), keysLabel(launcher)],
      [t("Search this page"), shortcut.search],
      [t("Sync all courses@@key"), shortcut.sync],
      [t("Back / Forward"), `${shortcut.back} / ${shortcut.forward}`],
      [t("Previous / next course"), `${shortcut.prevCourse} / ${shortcut.nextCourse}`],
      [t("Settings"), shortcut.settings],
      [t("Keyboard Shortcuts"), shortcut.shortcuts],
    ]],
    [t("In a course"), [
      [t("Tabs 1 to 9 (9: the last)"), shortcut.tab],
      [t("New tab"), shortcut.newTab],
      [t("Next tab"), shortcut.nextTab],
      [t("Previous tab"), shortcut.prevTab],
      [t("Announcements, assignments, Ed, pages: previous / next"), `${shortcut.up} / ${shortcut.down}`],
      [t("Page down / up"), isMac ? "Space / ⇧Space" : "Space / Shift+Space"],
    ]],
    [t("Files"), [
      [t("Select"), "↑ ↓ ← →"],
      [t("Open"), shortcut.open],
      ...(isMac ? [[t("Quick Look"), shortcut.preview] as [string, string]] : []),
      [copyName, shortcut.copy],
      [t("Rename"), shortcut.rename],
      [t("Enclosing folder"), shortcut.parent],
      [t("Move to {trash}", { trash: trashName }), shortcut.delete],
      ...(shortcut.toggleChanges ? [[t("Show modifications"), shortcut.toggleChanges] as [string, string]] : []),
    ]],
    [t("Search box"), [
      [t("Choose a result"), "↑ ↓"],
      [t("Open"), "↩"],
      [t("Show in folder"), isMac ? "⌘↩" : "Ctrl+Enter"],
      [t("Open in Canvas"), isMac ? "⌘⇧↩" : "Ctrl+Shift+Enter"],
      [t("Complete a course's name"), "⇥"],
      [t("Clear and leave the search box"), "Esc"],
    ]],
  ];
  return (
    <Dialog title={t("Keyboard Shortcuts")} onClose={onClose} width="max-w-xl" footer={<Button primary onClick={onClose}>{t("OK")}</Button>}>
      <div className="space-y-4 pb-2">
        {groups.map(([name, rows]) => (
          <section key={name}>
            <h3 className="mb-1 text-xs font-medium text-muted">{name}</h3>
            <dl className="divide-y divide-line">
              {rows.map(([what, keys]) => (
                <div key={what} className="flex items-center justify-between gap-4 py-1.5">
                  <dt>{what}</dt>
                  <dd className="shrink-0 font-mono text-xs text-fg-soft">{keys}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
