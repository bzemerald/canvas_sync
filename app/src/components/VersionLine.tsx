// The app's version and 检查更新, in a line: under the sign-in and the first choice of courses,
// where there's no 设置 yet. (设置 has its own row: VersionRow.)
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { checkForUpdate, installUpdate, useUpdate, type UpdateState } from "../lib/update";

/** How a check for updates is going, in words (null: nothing to say). */
export function updateSaying(update: UpdateState): string | null {
  switch (update.phase) {
    case "checking": return t("正在检查…");
    case "latest": return t("已是最新版本");
    case "available": return t("有新版本 {v}", { v: update.version });
    case "downloading":
      return t("正在下载 {v}…", { v: update.version }) + (update.progress === null ? "" : ` ${Math.round(update.progress * 100)}%`);
    case "installing": return t("正在安装，马上重启…");
    case "failed": return update.version ? t("更新失败") : t("检查失败");
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
        <button onClick={() => void installUpdate()} className="text-accent hover:underline">{t("更新并重启")}</button>
      ) : !busy && (
        <button onClick={() => void checkForUpdate()} className="text-accent hover:underline">{t("检查更新")}</button>
      )}
    </span>
  );
}
