// Connecting a Canvas account: the school's Canvas address, how to sign in (in a Canvas window
// of the app's, or with an access token, which some schools don't allow), and where the files go. What a new user sees first; in 设置, how you switch account or school.
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import * as api from "../lib/api";
import type { AccountInfo } from "../lib/api";
import { friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { Button } from "./Dialog";
import { LanguagePicker } from "./LanguagePicker";

/** How to make a Canvas token, when signing in and when replacing one. */
export const tokenSteps = () => t("在 Canvas 里点“账户 → 设置 → 已批准的集成 → + 新访问令牌”，“用途”填 Canvas Sync，把令牌粘贴到这里。过期后需要重新生成。");

/** Sign in in the app's Canvas window: its cookies (an error "cancelled" if it was closed). */
export const browserSignIn = (site: string, silent = false) => api.canvasLogin(site, t("登录 Canvas"), silent);

/** Closing the sign-in window isn't an error to show. */
export const cancelled = (e: unknown) => /cancelled/.test(String((e as Error)?.message ?? e));

/** "bcourses.berkeley.edu" -> "https://bcourses.berkeley.edu". */
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

export function SignInForm({ another, submitLabel, onDone, onCancel }: {
  another?: boolean; // switching from the account there is: address and folder start empty
  submitLabel?: string;
  onDone: (account: AccountInfo) => void;
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState("");
  const [how, setHow] = useState<"browser" | "token">("browser");
  const [token, setToken] = useState("");
  const [root, setRoot] = useState(another ? "" : "~/Canvas");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const site = siteOf(url);

  const choose = async () => {
    const picked = await open({ directory: true, title: t("选择同步文件夹"), defaultPath: !root || root.startsWith("~") ? undefined : root });
    if (typeof picked === "string") setRoot(picked);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const cred = how === "token" ? { token } : { cookies: await browserSignIn(site ?? "") };
      onDone(await api.setUp(url, cred, root));
    } catch (err) {
      if (!cancelled(err)) setError(friendly((err as Error).message));
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
      <div>
        <span className="mb-1 block font-medium">{t("登录方式")}</span>
        <div className="flex rounded-md border border-line p-0.5" role="radiogroup">
          {([["browser", t("在登录窗口中登录")], ["token", t("访问令牌")]] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={how === k} onClick={() => setHow(k)}
              className={`flex-1 rounded px-2 py-1 text-xs ${how === k ? "bg-selected font-medium text-accent" : "text-muted hover:text-fg"}`}>
              {label}
            </button>
          ))}
        </div>
        {how === "browser" ? (
          <span className="mt-1.5 block text-xs leading-relaxed text-muted">
            {t("会打开学校的 Canvas 登录页，像在浏览器里一样登录。学校不允许生成令牌时用这个。登录过一段时间会过期，到时候应用会尽量自动续上，续不上会请你再登录一次。")}
          </span>
        ) : (
          <>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("粘贴令牌")}
              autoComplete="off" spellCheck={false} className={`${inputClass} mt-2`} />
            <span className="mt-1.5 block text-xs leading-relaxed text-muted">
              {tokenSteps()}
              {site && (
                <button type="button" onClick={() => void api.openExternal(`${site}/profile/settings`)} className="ml-1 text-accent hover:underline">
                  {t("打开 Canvas 设置页")}
                </button>
              )}
            </span>
          </>
        )}
      </div>
      <div>
        <span className="mb-1 block font-medium">{t("同步文件夹")}</span>
        <div className="flex gap-2">
          <code className={`min-w-0 flex-1 truncate rounded-md border border-line bg-chip px-2.5 py-1.5 ${root ? "" : "font-sans text-muted"}`} title={root}>
            {root || t("还没选")}
          </code>
          <Button type="button" onClick={() => void choose()}>{t("选择…")}</Button>
        </div>
        <span className="mt-1.5 block text-xs text-muted">
          {another
            ? t("换成另一所学校时，请选一个新的同步文件夹：两所学校的课程不能放在同一个文件夹里。现在这个文件夹里的文件会原样保留。")
            : t("课程文件会下载到这里。选一个空文件夹，或者以前用过的同步文件夹。")}
        </span>
      </div>
      {error && <p className="text-danger">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && <Button type="button" onClick={onCancel}>{t("取消")}</Button>}
        <Button primary type="submit" disabled={busy || !site || (how === "token" && !token.trim()) || !root}>
          {busy ? t("正在登录…") : how === "browser" ? t("打开登录窗口…") : submitLabel ?? t("登录")}
        </Button>
      </div>
    </form>
  );
}

/** The whole window, before there's an account. */
export function SignInPage({ onDone }: { onDone: () => void }) {
  return (
    <div data-tauri-drag-region className="flex h-screen items-center justify-center overflow-y-auto bg-bg p-8 text-fg">
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
