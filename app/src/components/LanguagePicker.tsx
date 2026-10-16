import { emitTo } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { applyLanguage, t, type LangPref } from "../lib/i18n";

/** Language, in 设置 and on the sign-in page. Changing it reloads the windows. */
export function LanguagePicker() {
  const [value, setValue] = useState<LangPref | null>(null);
  useEffect(() => void api.prefs().then((p) => setValue(p.language), () => setValue("system")), []);
  const choose = async (language: LangPref) => {
    setValue(language);
    await api.setPrefs({ language }).catch(() => {});
    await emitTo("launcher", "prefs-changed", { language }).catch(() => {});
    applyLanguage(language);
  };
  return (
    <select value={value ?? "system"} disabled={value === null} onChange={(e) => void choose(e.target.value as LangPref)}
      className="rounded-md border border-line bg-bg px-2 py-1 text-sm">
      <option value="system">{t("跟随系统")}</option>
      <option value="zh">简体中文</option> {/* i18n-ignore: each language in its own words */}
      <option value="en">English</option>
    </select>
  );
}
