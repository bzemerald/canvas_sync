// Dates the way a student thinks about them: how long until it's due.
import { locale, t } from "./i18n";

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
    days === 0 ? t("今天")
    : days === 1 ? t("明天")
    : days === -1 ? t("昨天")
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
    ? (past ? t("已截止 {n} 分钟", { n: Math.max(1, Math.round(abs / 60000)) }) : t("还有 {n} 分钟", { n: Math.max(1, Math.round(abs / 60000)) }))
    : abs < DAY
      ? (past ? t("已截止 {n} 小时", { n: Math.round(abs / 3600000) }) : t("还有 {n} 小时", { n: Math.round(abs / 3600000) }))
      : (past ? t("已截止 {n} 天", { n: Math.round(abs / DAY) }) : t("还有 {n} 天", { n: Math.round(abs / DAY) }));
  return { text, urgent: !past && ms < 2 * DAY, past };
}
