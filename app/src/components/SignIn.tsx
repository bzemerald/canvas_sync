// Connecting a Canvas account: the school's Canvas address, an access token, and where the
// files go. What a new user sees first; in 设置, how you switch account or school.
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import * as api from "../lib/api";
import type { AccountInfo } from "../lib/api";
import { friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { Button } from "./Dialog";
import { LanguagePicker } from "./LanguagePicker";

/** "bcourses.berkeley.edu" -> "https://bcourses.berkeley.edu" (for the link to the token page). */
function siteOf(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  try {
    const parsed = new URL(u.includes("://") ? u : `https://${u}`);
    return parsed.hostname.includes(".") ? parsed.origin : null;
  } catch {
    return null;
  }
}

export const inputClass = "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent";

export function SignInForm({ initial, submitLabel, onDone, onCancel }: {
  initial?: { url?: string | null; root?: string | null };
  submitLabel?: string;
  onDone: (account: AccountInfo) => void;
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState(initial?.url?.replace(/^https:\/\//, "") ?? "");
  const [token, setToken] = useState("");
  const [root, setRoot] = useState(initial?.root ?? "~/Canvas");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const site = siteOf(url);

  const choose = async () => {
    const picked = await open({ directory: true, title: t("选择同步文件夹"), defaultPath: root.startsWith("~") ? undefined : root });
    if (typeof picked === "string") setRoot(picked);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.setUp(url, token, root));
    } catch (err) {
      setError(friendly((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-sm">
      <label className="block">
        <span className="mb-1 block font-medium">{t("学校的 Canvas 网址")}</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("例如 bcourses.berkeley.edu")} autoFocus
          spellCheck={false} autoCapitalize="off" className={inputClass} />
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">{t("访问令牌")}</span>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("粘贴令牌")}
          autoComplete="off" spellCheck={false} className={inputClass} />
        <span className="mt-1.5 block text-xs leading-relaxed text-muted">
          {t("在 Canvas 的“账户 → 设置”页面点“新访问令牌”生成一个，复制到这里。令牌只保存在这台电脑上。")}
          {site && (
            <button type="button" onClick={() => void api.openExternal(`${site}/profile/settings`)} className="ml-1 text-accent hover:underline">
              {t("打开 Canvas 设置页")}
            </button>
          )}
        </span>
      </label>
      <div>
        <span className="mb-1 block font-medium">{t("同步文件夹")}</span>
        <div className="flex gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-chip px-2.5 py-1.5" title={root}>{root}</code>
          <Button type="button" onClick={() => void choose()}>{t("选择…")}</Button>
        </div>
        <span className="mt-1.5 block text-xs text-muted">{t("课程文件会下载到这里。选一个空文件夹，或者以前用过的同步文件夹。")}</span>
      </div>
      {error && <p className="text-danger">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && <Button type="button" onClick={onCancel}>{t("取消")}</Button>}
        <Button primary type="submit" disabled={busy || !url.trim() || !token.trim()}>
          {busy ? t("正在登录…") : submitLabel ?? t("登录")}
        </Button>
      </div>
    </form>
  );
}

/** The whole window, before there's an account. */
export function SignInPage({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center overflow-y-auto bg-bg p-8 text-fg">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-xl font-semibold">{t("连接 Canvas")}</h1>
        <p className="mb-5 text-sm text-muted">{t("登录后，课程文件会同步到这台电脑上；公告、作业和成绩也能直接在这里看。")}</p>
        <div className="rounded-xl border border-line bg-panel p-5">
          <SignInForm onDone={onDone} />
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 text-xs text-muted">
          <span>{t("语言")}</span>
          <LanguagePicker />
        </div>
      </div>
    </div>
  );
}
