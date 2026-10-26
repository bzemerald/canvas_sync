// 设置: the account, syncing, language. Preferences are this computer's (app.toml, via the
// backend); which courses sync is the sync folder's (its config.toml), shared with the CLI.
import { CheckCircle2, CircleAlert, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { AccountInfo, Prefs, SyncState } from "../lib/api";
import { shortDate } from "../lib/dates";
import { edSaying, friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { shortcut } from "../lib/keys";
import { termRank } from "../lib/terms";
import { ChooseCourses } from "./ChooseCourses";
import { Button, Dialog } from "./Dialog";
import { LanguagePicker } from "./LanguagePicker";
import { SignInForm, inputClass } from "./SignIn";

const AUTO_SYNC: [number, string][] = [
  [0, t("不自动同步")], [30, t("每 30 分钟")], [60, t("每小时")], [180, t("每 3 小时")], [360, t("每 6 小时")], [1440, t("每天")],
];

export function Settings({ sync, onSync, onAccount, onShowFiles }: {
  sync: SyncState | null;
  onSync: () => void;
  onAccount: (a: AccountInfo) => void; // signed in or out
  onShowFiles: () => void; // the sync folder, in the app
}) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [version, setVersion] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null); // replacing the token
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = (a: AccountInfo) => {
    setAccount(a);
    onAccount(a);
  };
  useEffect(() => {
    void api.account().then(setAccount, () => {});
    void api.prefs().then(setPrefs, () => {});
    void api.health().then((h) => setVersion(h.version), () => {});
  }, []);
  useEffect(() => {
    if (!account?.signed_in) return void setCheck(null);
    void api.checkAccount().then(setCheck, () => setCheck(null));
  }, [account?.signed_in, account?.base_url]);

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
      changed(await api.replaceToken(newToken ?? ""));
      setNewToken(null);
      setCheck({ ok: true });
    } catch (e) {
      setTokenError(friendly((e as Error).message));
    }
  };
  const signOut = async () => {
    setConfirmSignOut(false);
    try {
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
                  <p className="mb-2 text-xs text-muted">{t("在 Canvas 的“账户 → 设置”页面点“新访问令牌”生成一个新的，粘贴到这里。")}</p>
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
                  <Button onClick={() => setNewToken("")}>{account.signed_in ? t("更换令牌…") : t("登录…")}</Button>
                  {account.signed_in && <Button onClick={() => setConfirmSignOut(true)}>{t("退出登录…")}</Button>}
                  <Button onClick={() => setSwitching(true)} disabled={!!sync?.running}>{t("切换账号或学校…")}</Button>
                </div>
              )}
              <Row label={t("同步文件夹")} hint={t("课程文件都在这里。")}>
                <span className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 truncate text-xs" title={account.root ?? ""}>{account.root}</code>
                  <button title={t("在应用中查看全部文件")} onClick={onShowFiles}
                    className="shrink-0 rounded p-1 text-muted hover:bg-chip hover:text-fg">
                    <FolderOpen className="size-4" />
                  </button>
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
          <Row label={t("快捷搜索")} hint={t("在任何应用里按这个组合键，打开搜索窗口。")}>
            <kbd className="rounded border border-line bg-chip px-1.5 py-0.5 text-xs">{shortcut.launcher}</kbd>
          </Row>
          <MeaningRow />
        </Section>

        <Section title={t("高级")}>
          <Row label={t("编辑高级同步规则")}>
            <Button onClick={() => void api.openConfig().catch((e) => setError(friendly(e.message)))}>{t("打开配置文件")}</Button>
          </Row>
          {version && <Row label={t("版本")}><span className="text-sm text-muted">{version}</span></Row>}
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
          <p className="text-fg-soft">{t("这台电脑上保存的令牌会被删除，之后不能再同步或打开外部工具。已经下载的文件、置顶和设置都会保留，重新登录后接着用。")}</p>
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
      {switching && account && (
        <Dialog title={t("切换账号或学校")} onClose={() => setSwitching(false)}>
          <p className="mb-4 text-xs text-muted">{t("换成另一所学校时，请选一个新的同步文件夹：两所学校的课程不能放在同一个文件夹里。现在这个文件夹里的文件会原样保留。")}</p>
          <div className="pb-3">
            <SignInForm
              initial={{ url: account.base_url, root: account.root }}
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
      {/token/.test(check.error ?? "") ? t("令牌已失效") : t("连不上 Canvas")}
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

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
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
