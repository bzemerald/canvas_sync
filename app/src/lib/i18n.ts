// The app's words. The code says them in Chinese; `t()` says them in the language chosen in
// 设置 (or the system's, by default). English is in en.ts, keyed by the Chinese.
//
// The language is settled once, as the window loads, so tables of labels made when a module
// loads come out right too; changing it reloads the window. It's kept in localStorage so it's
// known before the backend answers; the backend's copy (app.toml) is the one that counts.
import { createElement, Fragment, type ReactNode } from "react";
import { en } from "./en";

export type Lang = "zh" | "en";
export type LangPref = "system" | Lang;

const KEY = "pref:language";

function systemLang(): Lang {
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const resolveLang = (pref: LangPref): Lang => (pref === "system" ? systemLang() : pref);

function remembered(): LangPref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "system" || v === "zh" || v === "en") return v;
  } catch {
    /* unavailable: the system's */
  }
  return "system";
}

/** The language this window shows. */
export const lang: Lang = resolveLang(remembered());
document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

/** For dates and numbers. */
export const locale = lang === "zh" ? "zh-CN" : "en-US";

/** Show `pref` from now on: reloads the window if that changes the language. */
export function applyLanguage(pref: LangPref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    return; // it couldn't be remembered across the reload: keep what's showing
  }
  if (resolveLang(pref) !== lang) location.reload();
}

type Vars = Record<string, string | number>;

// The same Chinese can need different English: "置顶" is "Pin" on a menu and "Pinned" as a
// heading. The heading is written t("置顶@@heading"); what follows @@ only tells them apart.
const CONTEXT = "@@";

/** `zh` in the current language, with `{name}` filled in from `vars`. English entries can be
 * [singular, plural], chosen by `vars.n`. */
export function t(zh: string, vars?: Vars): string {
  let s = zh.includes(CONTEXT) ? zh.slice(0, zh.indexOf(CONTEXT)) : zh;
  if (lang === "en") {
    const e = en[zh];
    if (e === undefined) {
      if (import.meta.env.DEV) console.warn("[i18n] no English for:", zh);
    } else {
      s = typeof e === "string" ? e : Number(vars?.n) === 1 ? e[0] : e[1];
    }
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Like t(), for text with elements in it: `tx("按 {key} 搜索", { key: <kbd>⌘K</kbd> })`. */
export function tx(zh: string, parts: Record<string, ReactNode>): ReactNode[] {
  return t(zh).split(/(\{\w+\})/).map((piece, i) => {
    const name = piece.match(/^\{(\w+)\}$/)?.[1];
    return name && name in parts ? createElement(Fragment, { key: i }, parts[name]) : piece;
  });
}
