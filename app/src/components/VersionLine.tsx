// The app's version and Check for updates, in a line: under the sign-in and the first choice of courses,
// where there's no Settings yet. (Settings has its own row: VersionRow.)
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { checkForUpdate, installUpdate, useUpdate, type UpdateState } from "../lib/update";

/** How a check for updates is going, in words (null: nothing to say). */
export function updateSaying(update: UpdateState): string | null {
  switch (update.phase) {
    case "checking": return t("Checking…");
    case "latest": return t("Up to date");
    case "available": return t("Version {v} is available", { v: update.version });
    case "downloading":
      return t("Downloading {v}…", { v: update.version }) + (update.progress === null ? "" : ` ${Math.round(update.progress * 100)}%`);
    case "installing": return t("Installing, restarting soon…");
    case "failed": return update.version ? t("Update failed") : t("Couldn't check");
    default: return null;
  }
}

export function VersionLine() {
  const [version, setVersion] = useState("");
  const update = useUpdate();
  useEffect(() => void getVersion().then(setVersion, () => {}), []);
  const busy = update.phase === "checking" || update.phase === "downloading" || update.phase === "installing";
  const canInstall = update.phase === "available" || (update.phase === "failed" && !!update.version);
  const status = updateSaying(update);
  // v0.2.0 and how a check went on one line; what you can do under it (nothing while busy).
  return (
    <span className="mr-auto flex flex-col items-start gap-0.5 whitespace-nowrap">
      <span>
        {version && <span className="tabular-nums">v{version}</span>}
        {status && (
          <span className={`ml-1.5 ${update.phase === "failed" ? "text-danger" : update.phase === "available" ? "text-accent" : ""}`}
            title={update.phase === "failed" ? update.error : undefined}>
            {status}
          </span>
        )}
      </span>
      {canInstall ? (
        <button onClick={() => void installUpdate()} className="text-accent hover:underline">{t("Update and restart")}</button>
      ) : !busy && (
        <button onClick={() => void checkForUpdate()} className="text-accent hover:underline">{t("Check for updates")}</button>
      )}
    </span>
  );
}
