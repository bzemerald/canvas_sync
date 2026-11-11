// 设置: the account, syncing, language. Preferences are this computer's (app.toml, via the
// backend); which courses sync is the sync folder's (its config.toml), shared with the CLI.
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, CheckCircle2, CircleAlert, CircleQuestionMark, Copy, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { AccountInfo, Prefs, SyncState } from "../lib/api";
import { shortDate } from "../lib/dates";
import { edSaying, friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { chooseLauncherKeys, keysLabel, keysOf, setKeys, useLauncherKeys } from "../lib/launcherKeys";
import { fileManager, isMac } from "../lib/keys";
import { termRank } from "../lib/terms";
import { checkForUpdate, installUpdate, useUpdate } from "../lib/update";
import { ChooseCourses } from "./ChooseCourses";
import { Button, Dialog } from "./Dialog";
import { LanguagePicker } from "./LanguagePicker";
import { SignInForm, browserSignIn, cancelled, inputClass, tokenSteps } from "./SignIn";

const AUTO_SYNC: [number, string][] = [
  [0, t("不自动同步")], [30, t("每 30 分钟")], [60, t("每小时")], [180, t("每 3 小时")], [360, t("每 6 小时")], [1440, t("每天")],
];

export function Settings({ account, sync, onSync, onAccount }: {
  account: AccountInfo | null; // the main window's (signing in again happens there too)
  sync: SyncState | null;
  onSync: () => void;
  onAccount: (a: AccountInfo) => void; // signed in or out
}) {
  const [check, setCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null); // replacing the token
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [moving, setMoving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = onAccount;
  useEffect(() => {
    void api.prefs().then(setPrefs, () => {});
  }, []);
  // Again whenever the account is told anew: signed in again, here or from the sidebar.
  useEffect(() => {
    if (!account?.signed_in) return void setCheck(null);
    void api.checkAccount().then(setCheck, () => setCheck(null));
  }, [account]);

  const update = async (changes: Partial<Prefs>) => {
    setError(null);
    try {
      setPrefs(await api.setPrefs(changes));
    } catch (e) {
      setError(friendly((e as Error).message));
    }
  };
  const saveToken = async () => {
    setTokenError(null);
    try {
      changed(await api.replaceCredentials({ token: newToken ?? "" }));
      setNewToken(null);
      setCheck({ ok: true });
    } catch (e) {
      setTokenError(friendly((e as Error).message));
    }
  };
  /** Signing in again in the Canvas window (or for the first time, instead of a token). */
  const signInAgain = async () => {
    if (!account?.base_url) return;
    setError(null);
    try {
      changed(await api.replaceCredentials({ cookies: await browserSignIn(account.base_url) }));
      setNewToken(null);
      setCheck({ ok: true });
    } catch (e) {
      if (!cancelled(e)) setError(friendly((e as Error).message));
    }
  };
  const signOut = async () => {
    setConfirmSignOut(false);
    try {
      if (account?.auth === "session") await api.canvasLogout(); // (the next sign-in asks who you are)
      changed(await api.signOut());
    } catch (e) {
      setError(friendly((e as Error).message));
    }
  };

  const last = sync?.running ? null : sync?.last_synced ?? sync?.finished_at ?? null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-5 px-6 py-6">
        {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        <Section title={t("账号")}>
          {account && (
            <>
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-selected text-sm font-semibold text-accent">
                  {(account.user ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{account.user ?? t("Canvas 用户")}</p>
                  <p className="truncate text-xs text-muted">{account.base_url?.replace(/^https?:\/\//, "")}</p>
                </div>
                <AccountStatus account={account} check={check} />
              </div>
              {newToken !== null ? (
                <div className="border-t border-line px-4 py-3">
                  <p className="mb-2 text-xs text-muted">{tokenSteps()}</p>
                  <div className="flex gap-2">
                    <input type="password" autoFocus value={newToken} onChange={(e) => setNewToken(e.target.value)} placeholder={t("粘贴令牌")}
                      autoComplete="off" spellCheck={false} className={inputClass} onKeyDown={(e) => e.key === "Enter" && void saveToken()} />
                    <Button onClick={() => (setNewToken(null), setTokenError(null))}>{t("取消")}</Button>
                    <Button primary disabled={!newToken.trim()} onClick={() => void saveToken()}>{t("保存")}</Button>
                  </div>
                  {tokenError && <p className="mt-2 text-xs text-danger">{tokenError}</p>}
                  {account.base_url && (
                    <button onClick={() => void api.openExternal(`${account.base_url}/profile/settings`)} className="mt-2 text-xs text-accent hover:underline">
                      {t("打开 Canvas 设置页")}
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
                  {account.auth !== "token" && (
                    <Button onClick={() => void signInAgain()}>{account.signed_in ? t("重新登录…") : t("在登录窗口中登录…")}</Button>
                  )}
                  {account.auth !== "session" && (
                    <Button onClick={() => setNewToken("")}>{account.signed_in ? t("更换令牌…") : t("用令牌登录…")}</Button>
                  )}
                  {account.signed_in && <Button onClick={() => setConfirmSignOut(true)}>{t("退出登录…")}</Button>}
                  <Button onClick={() => setSwitching(true)} disabled={!!sync?.running}>{t("切换账号或学校…")}</Button>
                </div>
              )}
              <Row label={t("同步文件夹")} hint={t("课程文件都在这里。")}>
                <span className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 truncate text-xs" title={account.root ?? ""}>{account.root}</code>
                  <button title={t("在 {app} 中打开", { app: fileManager })} onClick={() => void api.openPath("")}
                    className="shrink-0 rounded p-1 text-muted hover:bg-chip hover:text-fg">
                    <FolderOpen className="size-4" />
                  </button>
                  <Button onClick={() => setMoving(true)} disabled={!!sync?.running} className="shrink-0 px-2.5! py-1! text-xs!">
                    {t("移动…")}
                  </Button>
                </span>
              </Row>
            </>
          )}
        </Section>

        {account?.set_up && <EdSection syncing={!!sync?.running} />}

        <Section title={t("同步")}>
          {prefs && (
            <>
              <Row label={t("自动同步")} hint={t("应用开着时（包括窗口关掉、只在后台时）按这个间隔从 Canvas 拉取。")}>
                <select value={prefs.auto_sync} onChange={(e) => void update({ auto_sync: Number(e.target.value) })}
                  className="rounded-md border border-line bg-bg px-2 py-1 text-sm">
                  {AUTO_SYNC.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
                </select>
              </Row>
              <Row label={t("打开应用时同步")} hint={t("距离上次同步超过 10 分钟时。")}>
                <Toggle on={prefs.sync_on_launch} onChange={(v) => void update({ sync_on_launch: v })} />
              </Row>
              <Row label={t("要同步的课程")}>
                <Button onClick={() => setChoosing(true)} disabled={!account?.signed_in}>{t("选择课程…")}</Button>
              </Row>
              <Row label={t("上次同步")}>
                <span className="flex items-center gap-3 text-sm">
                  <span className="text-muted">{sync?.running ? t("正在同步…") : last ? shortDate(last) : t("还没有同步过")}</span>
                  <Button onClick={onSync} disabled={!!sync?.running || !account?.signed_in} className="flex items-center gap-1.5">
                    <RefreshCw className="size-3.5" />{t("立即同步")}
                  </Button>
                </span>
              </Row>
            </>
          )}
        </Section>

        <Section title={t("通用")}>
          <Row label={t("语言")}>
            <LanguagePicker />
          </Row>
        </Section>

        <Section title={t("搜索")}>
          <LauncherKeysRow />
          <MeaningRow />
        </Section>

        {account?.set_up && <AssistantSection />}

        <Section title={t("高级")}>
          <Row label={t("编辑高级同步规则")}>
            <Button onClick={() => void api.openConfig().catch((e) => setError(friendly(e.message)))}>{t("打开配置文件")}</Button>
          </Row>
          <VersionRow />
        </Section>
      </div>

      {confirmSignOut && (
        <Dialog
          title={t("退出登录？")}
          onClose={() => setConfirmSignOut(false)}
          footer={
            <>
              <Button onClick={() => setConfirmSignOut(false)}>{t("取消")}</Button>
              <Button danger autoFocus onClick={() => void signOut()}>{t("退出登录")}</Button>
            </>
          }
        >
          <p className="text-fg-soft">{account?.auth === "session"
            ? t("这台电脑上保存的 Canvas 登录会被删除，之后不能再同步或打开外部工具。已经下载的文件、置顶和设置都会保留，重新登录后接着用。")
            : t("这台电脑上保存的令牌会被删除，之后不能再同步或打开外部工具。已经下载的文件、置顶和设置都会保留，重新登录后接着用。")}</p>
        </Dialog>
      )}
      {choosing && (
        <Dialog title={t("要同步的课程")} onClose={() => setChoosing(false)}>
          <div className="pb-3">
            <ChooseCourses
              submitLabel={t("保存")}
              onCancel={() => setChoosing(false)}
              onDone={(_, added) => {
                setChoosing(false);
                if (added.length && !sync?.running) onSync(); // (what was ticked comes now)
              }}
            />
          </div>
        </Dialog>
      )}
      {moving && account?.root && <MoveFolderDialog root={account.root} onClose={() => setMoving(false)} />}
      {switching && account && (
        <Dialog title={t("切换账号或学校")} onClose={() => setSwitching(false)}>
          <div className="pb-3">
            <SignInForm
              another
              submitLabel={t("切换")}
              onCancel={() => setSwitching(false)}
              onDone={() => location.reload()} // everything is someone else's now
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}

function AccountStatus({ account, check }: { account: AccountInfo; check: { ok: boolean; error?: string } | null }) {
  if (!account.signed_in) {
    return <span className="flex shrink-0 items-center gap-1 text-xs text-muted"><CircleAlert className="size-3.5" />{t("未登录")}</span>;
  }
  if (!check) return <span className="shrink-0 text-xs text-muted">{t("正在检查…")}</span>;
  if (check.ok) return <span className="flex shrink-0 items-center gap-1 text-xs text-ok"><CheckCircle2 className="size-3.5" />{t("已登录")}</span>;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-danger" title={friendly(check.error ?? "")}>
      <CircleAlert className="size-3.5" />
      {/sign-in rejected/.test(check.error ?? "") ? t("登录已过期") : /token/.test(check.error ?? "") ? t("令牌已失效") : t("连不上 Canvas")}
    </span>
  );
}

/** Ed: connecting it (a token made on Ed), how it's going, and which course each Ed course is. */
function EdSection({ syncing }: { syncing: boolean }) {
  const [state, setState] = useState<api.EdState | null>(null);
  const [token, setToken] = useState<string | null>(null); // connecting
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (!syncing) void api.ed().then(setState, () => {}); // (again after a sync: how it went)
  }, [syncing]);
  if (!state) return null;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.connectEd(token ?? ""));
      setToken(null);
    } catch (e) {
      setError(edSaying((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const act = (call: Promise<api.EdState>) => void call.then(setState, (e) => setError(friendly((e as Error).message)));
  // Newest term first; of those not matched, ones still going on first.
  const courses = [...state.courses].sort((a, b) => termRank(b.term) - termRank(a.term));
  const linked = courses.filter((c) => c.course !== null);
  const others = courses.filter((c) => c.course === null).sort((a, b) => Number(a.archived) - Number(b.archived));
  const canvas = [...state.canvas].sort((a, b) => termRank(b.term) - termRank(a.term));

  return (
    <Section title="Ed">
      {state.connected && token === null ? (
        <>
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-selected text-sm font-semibold text-accent">
              {(state.user ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{state.user ?? t("Ed 用户")}</p>
              <p className="truncate text-xs text-muted">
                {state.error ? <span className="text-danger">{edSaying(state.error)}</span>
                  : state.ok_at ? t("上次同步 {when}", { when: shortDate(state.ok_at) }) : "edstem.org"}
              </p>
            </div>
            {state.error
              ? <span className="flex shrink-0 items-center gap-1 text-xs text-danger"><CircleAlert className="size-3.5" />{t("出错了")}</span>
              : <span className="flex shrink-0 items-center gap-1 text-xs text-ok"><CheckCircle2 className="size-3.5" />{t("已连接")}</span>}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
            <Button onClick={() => setToken("")}>{t("更换令牌…")}</Button>
            <Button onClick={() => act(api.disconnectEd())}>{t("断开")}</Button>
          </div>
        </>
      ) : token === null ? (
        <Row label="Ed Discussion" hint={t("连上之后，每门课在 Ed 上的公告和帖子会出现在这门课里。只读：不会替你发帖，也不会标成已读。")}>
          <Button onClick={() => setToken("")}>{t("连接…")}</Button>
        </Row>
      ) : (
        <div className="px-4 py-3">
          <p className="mb-2 text-xs text-muted">{t("在 Ed 的“Settings → API Tokens”页面生成一个令牌，粘贴到这里。")}</p>
          <div className="flex gap-2">
            <input type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("粘贴令牌")}
              autoComplete="off" spellCheck={false} className={inputClass} onKeyDown={(e) => e.key === "Enter" && !busy && void connect()} />
            <Button onClick={() => (setToken(null), setError(null))}>{t("取消")}</Button>
            <Button primary disabled={!token.trim() || busy} onClick={() => void connect()}>{busy ? t("正在连接…") : t("连接")}</Button>
          </div>
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          <button onClick={() => void api.openExternal(state.token_page)} className="mt-2 text-xs text-accent hover:underline">
            {t("打开 Ed 的令牌页")}
          </button>
        </div>
      )}
      {state.courses.length > 0 && (
        <div className="px-4 py-3">
          <p className="text-sm">{t("课程@@ed")}</p>
          <p className="mt-0.5 mb-2 text-xs leading-relaxed text-muted">{t("每个 Ed 课程是哪门课。")}</p>
          <div className="space-y-1.5">
            {[...linked, ...(showAll ? others : [])].map((c) => (
              <div key={c.id} className={`flex items-center gap-3 ${c.archived && c.course === null ? "opacity-60" : ""}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{c.code || c.name}</p>
                  <p className="truncate text-xs text-muted">{[c.code && c.name !== c.code ? c.name : "", c.term].filter(Boolean).join(" · ")}</p>
                </div>
                <select value={c.course ?? ""} onChange={(e) => act(api.linkEd(c.id, e.target.value ? Number(e.target.value) : null))}
                  className="max-w-56 min-w-0 shrink rounded-md border border-line bg-bg px-2 py-1 text-sm">
                  <option value="">{t("不属于任何课程")}</option>
                  {canvas.map((x) => <option key={x.id} value={x.id}>{x.term ? `${x.label} · ${x.term}` : x.label}</option>)}
                </select>
              </div>
            ))}
          </div>
          {others.length > 0 && (
            <button onClick={() => setShowAll(!showAll)} className="mt-2 text-xs text-accent hover:underline">
              {showAll ? t("只看已对上的") : t("还有 {n} 个没对上课程的 Ed 课程", { n: others.length })}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 px-1 text-xs font-medium text-muted">{title}</h2>
      <div className="divide-y divide-line rounded-xl border border-line bg-panel">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p>}
      </div>
      <div className="flex min-w-0 shrink-0 justify-end">{children}</div>
    </div>
  );
}

/** 版本: this one, and 检查更新 (which the app also does by itself now and then). */
function VersionRow() {
  const [version, setVersion] = useState("");
  const update = useUpdate();
  useEffect(() => void getVersion().then(setVersion, () => {}), []);
  const status =
    update.phase === "checking" ? t("正在检查…")
      : update.phase === "latest" ? t("已是最新版本")
        : update.phase === "available" ? t("有新版本 {v}", { v: update.version })
          : update.phase === "downloading" ? t("正在下载 {v}…", { v: update.version }) + (update.progress === null ? "" : ` ${Math.round(update.progress * 100)}%`)
            : update.phase === "installing" ? t("正在安装，马上重启…")
              : null;
  return (
    <Row label={t("版本")} hint={version ? <span className="tabular-nums">{version}</span> : undefined}>
      <span className="flex items-center gap-3 text-sm">
        {update.phase === "failed"
          ? <span className="flex items-center gap-1 text-xs text-danger" title={update.error}><CircleAlert className="size-3.5" />{update.version ? t("更新失败") : t("检查失败")}</span>
          : status && <span className={update.phase === "available" ? "text-accent" : "text-muted"}>{status}</span>}
        {update.phase === "available" || (update.phase === "failed" && update.version)
          ? <Button onClick={() => void installUpdate()}>{t("更新并重启")}</Button>
          : <Button onClick={() => void checkForUpdate()} disabled={update.phase === "checking" || update.phase === "downloading" || update.phase === "installing"}>{t("检查更新")}</Button>}
      </span>
    </Row>
  );
}

/** Searching by meaning (English, a model downloaded when it's turned on): on or off, and how
 * getting it ready is going (shown as it goes). */
function MeaningRow() {
  const [state, setState] = useState<api.MeaningState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = state?.phase === "downloading" || state?.phase === "indexing";
  useEffect(() => {
    let live = true;
    const load = () => void api.meaning().then((s) => live && setState(s), () => {});
    load();
    const timer = busy ? setInterval(load, 1000) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [busy]);
  if (!state) return null;
  const turn = (on: boolean) => {
    setError(null);
    void api.setMeaning(on).then(setState, (e) => setError(friendly((e as Error).message)));
  };
  const pct = state.total ? Math.floor((100 * state.done) / state.total) : 0;
  // (Only while something's happening: the row keeps its height otherwise, and the switch its place.)
  const status = error
    ?? (state.phase === "downloading" ? t("正在下载模型… {pct}%", { pct })
      : state.phase === "indexing" && state.total ? t("正在整理正文… {done}/{total}", { done: state.done, total: state.total })
      : state.phase === "failed" ? t("没能准备好：{error}", { error: friendly(state.error) })
      : null);
  return (
    <Row
      label={t("按意思搜索")}
      hint={
        <>
          {t("用一个英文小模型（约 125 MB，打开时下载）改善搜索，允许按意思找正文。")}
          {status && <span className={`mt-1 block ${state.phase === "failed" || error ? "text-danger" : "text-fg-soft"}`}>{status}</span>}
        </>
      }
    >
      <Toggle on={state.on} onChange={turn} />
    </Row>
  );
}

/** Everything in the sync folder, moved to an empty folder of your choice. */
function MoveFolderDialog({ root, onClose }: { root: string; onClose: () => void }) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftBehind, setLeftBehind] = useState<string | null>(null);
  const choose = async () => {
    const picked = await open({ directory: true, title: t("选择同步文件夹") });
    if (typeof picked === "string") {
      setTarget(picked);
      setError(null);
    }
  };
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const { left_behind } = await api.moveWorkspace(target);
      if (left_behind) setLeftBehind(left_behind);
      else location.reload(); // every path is somewhere else now
    } catch (e) {
      setError(friendly((e as Error).message));
      setBusy(false);
    }
  };
  if (leftBehind) {
    return (
      <Dialog title={t("移动同步文件夹")} onClose={stay}
        footer={<Button primary onClick={() => location.reload()}>{t("完成")}</Button>}>
        <p className="mb-2 text-fg-soft [overflow-wrap:anywhere] select-text">
          {t("文件已经移好了，但旧文件夹没能删干净，可以自己删掉：{path}", { path: leftBehind })}
        </p>
      </Dialog>
    );
  }
  return (
    <Dialog title={t("移动同步文件夹")} onClose={busy ? stay : onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>{t("取消")}</Button>
          <Button primary disabled={busy || !target} onClick={() => void go()}>
            {busy ? t("正在移动…") : t("移动")}
          </Button>
        </>
      }>
      <p className="mb-1 font-medium">{t("现在的位置")}</p>
      <code className="mb-3 block truncate rounded-md border border-line bg-chip px-2.5 py-1.5" title={root}>{root}</code>
      <p className="mb-1 font-medium">{t("移到")}</p>
      <div className="flex gap-2">
        <code className={`min-w-0 flex-1 truncate rounded-md border border-line bg-chip px-2.5 py-1.5 ${target ? "" : "font-sans text-muted"}`} title={target}>
          {target || t("还没选")}
        </code>
        <Button disabled={busy} onClick={() => void choose()}>{t("选择…")}</Button>
      </div>
      <p className="mt-1.5 mb-3 text-xs text-muted">{t("选一个空文件夹。所有课程文件和设置都会搬过去，不用重新下载。")}</p>
      {error && <p className="mb-3 text-danger [overflow-wrap:anywhere] select-text">{error}</p>}
    </Dialog>
  );
}

/** AI assistants (MCP): adding `canvas mcp` (agent.py) to the AI apps on this computer, or by hand
 * to others. It reads what's synced here, only. */
function AssistantSection() {
  const [apps, setApps] = useState<api.Assistant[] | null>(null);
  const [how, setHow] = useState<{ command: string; args: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ app: api.Assistant; preview: api.AssistantPreview } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<Set<string>>(new Set()); // just now: say when it's seen
  useEffect(() => {
    void api.assistants().then(setApps, () => setApps([]));
    void api.mcpCommand().then(setHow, () => {});
  }, []);
  // Says what would change first (a file it can't read: says so on its row, and nothing opens).
  const ask = async (a: api.Assistant, add: boolean) => {
    setBusy(a.id);
    setErrors(({ [a.id]: _, ...rest }) => rest);
    try {
      setAsking({ app: a, preview: await api.assistantPreview(a.id, !add) });
    } catch (e) {
      setErrors((x) => ({ ...x, [a.id]: friendly((e as Error).message) }));
    } finally {
      setBusy(null);
    }
  };
  const installed = (apps ?? []).filter((a) => a.installed || a.added);
  const servers = how && { "canvas-sync": { command: how.command, args: how.args } };
  return (
    <>
    <Section title={t("AI 助手")}>
      <div className="px-4 py-3">
        <p className="text-sm">{t("连接到 AI 桌面软件")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("允许外部 AI 软件（如 ChatGPT 和 Claude）搜索和阅读你已同步的课程。")}</p>
      </div>
      {apps && installed.length === 0 && <p className="px-4 py-3 text-sm text-muted">{t("这台电脑上没找到支持的 AI 应用。")}</p>}
      {installed.map((a) => {
        const note = errors[a.id]
          ?? (added.has(a.id) && a.added
            ? (a.restart ? t("重新打开 {app} 后就能用。", { app: a.name }) : t("在 {app} 新开的对话里就能用。", { app: a.name }))
            : a.added && !a.current ? t("用的是另一份 Canvas Sync。") : null);
        return (
          <Row key={a.id}
            label={
              <span className="flex items-center gap-1.5">
                {a.name}
                {a.added && (a.current
                  ? <CheckCircle2 className="size-3.5 text-ok" aria-label={t("已连接@@assistant")} />
                  : <CircleQuestionMark className="size-3.5 text-warn" aria-label={t("用的是另一份 Canvas Sync。")} />)}
              </span>
            }
            hint={note && <span className={errors[a.id] ? "text-danger" : ""}>{note}</span>}>
            {a.added && a.current
              ? <Button disabled={busy !== null} onClick={() => void ask(a, false)}>{t("断开…@@assistant")}</Button>
              : <Button disabled={busy !== null} onClick={() => void ask(a, true)}>
                  {a.added ? t("改用这一份…") : t("连接…@@assistant")}
                </Button>}
          </Row>
        );
      })}
      {how && servers && (
        <details className="px-4 py-3">
          <summary className="cursor-default text-xs text-muted select-none hover:text-fg">{t("手动添加到其他应用")}</summary>
          <div className="mt-3 space-y-4">
            <Copyable label={t("配置")} hint={t("大多数应用的 MCP 设置用这个格式：")}
              text={JSON.stringify({ mcpServers: servers }, null, 2)} />
            <Copyable label={t("命令")} hint={t("只要填命令的应用用这个：")} text={`"${how.command}" ${how.args.join(" ")}`} />
          </div>
        </details>
      )}
    </Section>
    {/* (Outside the card: its rows are divided by borders.) */}
    {asking && (
      <AssistantChangeDialog app={asking.app} preview={asking.preview} onClose={() => setAsking(null)}
        onDone={(now) => {
          const id = asking.app.id;
          setApps(now);
          setAdded((s) => (asking.preview.action !== "remove" ? new Set(s).add(id) : new Set([...s].filter((x) => x !== id))));
          setAsking(null);
        }} />
    )}
    </>
  );
}

const stay = () => {};

/** Before another app's config file is changed: which file, and what in it. */
function AssistantChangeDialog({ app, preview, onClose, onDone }: {
  app: api.Assistant;
  preview: api.AssistantPreview;
  onClose: () => void;
  onDone: (apps: api.Assistant[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { action, key } = preview;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await (action === "remove" ? api.removeAssistant(app.id) : api.addAssistant(app.id)));
    } catch (e) {
      setError(friendly((e as Error).message));
      setBusy(false);
    }
  };
  const lines = (text: string | null, mark: string, color: string) => text?.split("\n").map((line, i) => (
    <div key={`${mark}${i}`} className={color}>{mark} {line}</div>
  ));
  return (
    <Dialog
      title={action === "add" ? t("让 {app} 读取你的课程？", { app: app.name })
        : action === "replace" ? t("让 {app} 改用这一份 Canvas Sync？", { app: app.name })
        : t("不再让 {app} 读取你的课程？", { app: app.name })}
      onClose={busy ? stay : onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>{t("取消")}</Button>
          <Button primary autoFocus disabled={busy} onClick={() => void go()}>
            {action === "add" ? t("连接@@assistant") : action === "replace" ? t("改用这一份") : t("断开@@assistant")}
          </Button>
        </>
      }
    >
      <div className="mb-3 space-y-2 text-fg-soft">
        <p>
          {action === "add" ? t("{app} 将能搜索和阅读你已同步的课程，但不能改动任何内容。", { app: app.name })
            : action === "replace" ? t("{app} 现在连接的是另一份 Canvas Sync（比如旧版本），之后会断开它，改为连接你正在用的这一份。", { app: app.name })
            : t("{app} 将不能再读取你的课程。你的课程和文件不受影响。", { app: app.name })}
        </p>
        <p>
          {action === "remove" ? t("Canvas Sync 会从 {app} 的设置文件里删掉连接信息。你的其他设置不会变，修改前也会先备份原文件。", { app: app.name })
            : !preview.exists ? t("为此，Canvas Sync 会为 {app} 新建一个设置文件，里面只有连接所需的信息。", { app: app.name })
            : action === "replace" ? t("为此，Canvas Sync 会修改 {app} 的设置文件，只更新连接信息。你的其他设置不会变，修改前也会先备份原文件。", { app: app.name })
            : t("为此，Canvas Sync 会修改 {app} 的设置文件，加上连接所需的信息。你的其他设置不会变，修改前也会先备份原文件。", { app: app.name })}
        </p>
      </div>
      <details className="mb-3">
        <summary className="cursor-default text-xs text-muted select-none hover:text-fg">{t("查看具体改动")}</summary>
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium">{preview.exists ? t("会修改的配置文件：") : t("会新建的配置文件：")}</p>
          <pre className="mb-3 rounded-md border border-line bg-chip px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
            {preview.path}
          </pre>
          <p className="mb-1.5 text-xs font-medium">
            {action === "add" ? t("在 {key} 里加入这一项：", { key })
              : action === "replace" ? t("替换 {key} 里的这一项：", { key })
              : t("从 {key} 里删去这一项：", { key })}
          </p>
          <pre className="mb-3 rounded-md border border-line bg-chip px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
            {lines(preview.removed, "-", "text-danger")}
            {lines(preview.added, "+", "text-ok")}
          </pre>
          <div className="space-y-1 text-xs text-muted [overflow-wrap:anywhere] select-text">
            {preview.backup && <p>{t("原文件会备份到 {path}（只保留最近一份）。", { path: preview.backup })}</p>}
            {action !== "remove" && <p>{t("如果以后 Canvas Sync 换了位置，它会自动更新这一项。")}</p>}
          </div>
        </div>
      </details>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
    </Dialog>
  );
}

/** Text to paste somewhere else, under what it's for, with a button that copies it. */
function Copyable({ label, hint, text }: { label: string; hint: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard.writeText(text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, () => {});
  return (
    <div>
      <div className="mb-1.5 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{label}</p>
          <p className="mt-0.5 text-xs text-muted">{hint}</p>
        </div>
        <Button onClick={copy} className="flex shrink-0 items-center gap-1.5 px-2.5! py-1! text-xs!">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t("已复制") : t("复制")}
        </Button>
      </div>
      {/* (Long lines wrap: copying gives the text as it is.) */}
      <pre className="rounded-md border border-line bg-chip px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
        {text}
      </pre>
    </div>
  );
}

/** The keys that open the search window: click, then press new ones (Esc: keep these). */
function LauncherKeysRow() {
  const keys = useLauncherKeys();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!listening) return;
    // The current keys let go of, so pressing them again is heard here too.
    void setKeys(null).catch(() => {});
    let chose = false;
    const stop = () => setListening(false);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation(); // not the window's own keys (⌘F, ⌘,...)
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) return stop();
      const got = keysOf(e);
      if (got === null) return;
      if (got === "no modifier") return setError(isMac ? t("要带上 ⌘、⌃ 或 ⌥。") : t("要带上 Ctrl、Alt 或 Win。"));
      chose = true;
      setListening(false);
      void chooseLauncherKeys(got).then(() => setError(null), (err) => {
        setError(t("这个组合键用不了（可能已被别的应用占用）：{why}", { why: friendly(String((err as Error)?.message ?? err)) }));
        void setKeys(keys).catch(() => {});
      });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
      if (!chose) void setKeys(keys).catch(() => {}); // stopped without new keys: the old ones again
    };
  }, [listening, keys]);
  return (
    <Row
      label={t("快捷搜索的快捷键")}
      hint={
        <>
          {t("在任何应用里按这个组合键，打开搜索窗口。点它，再按新的组合键来更换。")}
          {error && <span className="mt-1 block text-danger">{error}</span>}
        </>
      }
    >
      <span className="flex items-center gap-2">
        {keys && !listening && (
          <button onClick={() => void chooseLauncherKeys("").then(() => setError(null), () => {})} className="text-xs text-accent hover:underline">
            {t("恢复默认")}
          </button>
        )}
        <button
          onClick={() => (setError(null), setListening(!listening))}
          className={`min-w-24 rounded border px-2 py-0.5 text-xs ${listening ? "border-accent bg-selected text-accent" : "border-line bg-chip hover:border-fg-soft"}`}
        >
          {listening ? t("按下组合键…") : keysLabel(keys)}
        </button>
      </span>
    </Row>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-accent" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${on ? "left-4.5" : "left-0.5"}`} />
    </button>
  );
}
