// Dates the way a student thinks about them: how long until it's due.
import { locale, t, tn } from "./i18n";

const DAY = 24 * 3600 * 1000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "今天" / "明天" / "周四" / "10月20日", plus the time if it isn't midnight. */
export function shortDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
  const day =
    days === 0 ? t("Today")
    : days === 1 ? t("Tomorrow")
    : days === -1 ? t("Yesterday")
    : days > 1 && days < 7 ? d.toLocaleDateString(locale, { weekday: "short" })
    : d.toLocaleDateString(locale, d.getFullYear() === new Date().getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  const time = withTime && (d.getHours() || d.getMinutes()) ? ` ${d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}` : "";
  return day + time;
}

/** "还有 2 天" / "还有 5 小时" / "已截止 3 天". */
export function untilDue(iso: string | null | undefined): { text: string; urgent: boolean; past: boolean } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  const past = ms < 0;
  const abs = Math.abs(ms);
  const text = abs < 3600 * 1000
    ? (past ? tn("1 minute ago", "{n} minutes ago", { n: Math.max(1, Math.round(abs / 60000)) }) : tn("in 1 minute", "in {n} minutes", { n: Math.max(1, Math.round(abs / 60000)) }))
    : abs < DAY
      ? (past ? tn("1 hour ago", "{n} hours ago", { n: Math.round(abs / 3600000) }) : tn("in 1 hour", "in {n} hours", { n: Math.round(abs / 3600000) }))
      : (past ? tn("1 day ago", "{n} days ago", { n: Math.round(abs / DAY) }) : tn("in 1 day", "in {n} days", { n: Math.round(abs / DAY) }));
  return { text, urgent: !past && ms < 2 * DAY, past };
}
