// The app's words. The code says them in English; `t()` says them in the language chosen in
// Settings (or the system's, by default). Chinese is in zh.ts, keyed by the English.
//
// The language is settled once, as the window loads, so tables of labels made when a module
// loads come out right too; changing it reloads the window. It's kept in localStorage so it's
// known before the backend answers; the backend's copy (app.toml) is the one that counts.
import { createElement, Fragment, type ReactNode } from "react";
import { zh } from "./zh";

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

// The same English can need different Chinese: "Restore" is 还原 on a window's button and 改回原版
// for a file. The file's is written t("Restore@@file"); what follows @@ only tells them apart.
const CONTEXT = "@@";

function fill(s: string, vars?: Vars): string {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

function say(en: string): string {
  if (lang === "zh") {
    const z = zh[en];
    if (z !== undefined) return z;
    if (import.meta.env.DEV) console.warn("[i18n] no Chinese for:", en);
  }
  return en.includes(CONTEXT) ? en.slice(0, en.indexOf(CONTEXT)) : en;
}

/** `en` in the current language, with `{name}` filled in from `vars`. */
export function t(en: string, vars?: Vars): string {
  return fill(say(en), vars);
}

/** A string that counts `vars.n`: `one` when it's 1 in English, `many` otherwise (and the key in
 * zh.ts: Chinese says both alike). */
export function tn(one: string, many: string, vars: Vars): string {
  return lang === "en" && Number(vars.n) === 1 ? fill(one, vars) : t(many, vars);
}

/** Like t(), for text with elements in it: `tx("Press {key} to search", { key: <kbd>⌘K</kbd> })`. */
export function tx(en: string, parts: Record<string, ReactNode>): ReactNode[] {
  return t(en).split(/(\{\w+\})/).map((piece, i) => {
    const name = piece.match(/^\{(\w+)\}$/)?.[1];
    return name && name in parts ? createElement(Fragment, { key: i }, parts[name]) : piece;
  });
}
