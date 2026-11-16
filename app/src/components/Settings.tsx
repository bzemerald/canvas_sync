// Settings: the account, syncing, language. Preferences are this computer's (app.toml, via the
// backend); which courses sync is the sync folder's (its config.toml), shared with the CLI.
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, CheckCircle2, CircleAlert, CircleQuestionMark, Copy, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { AccountInfo, Prefs, SyncState } from "../lib/api";
import { shortDate } from "../lib/dates";
import { edSaying, friendly } from "../lib/errors";
import { t, tn } from "../lib/i18n";
import { chooseLauncherKeys, keysLabel, keysOf, setKeys, useLauncherKeys } from "../lib/launcherKeys";
import { fileManager, isMac } from "../lib/keys";
import { termRank } from "../lib/terms";
import { checkForUpdate, installUpdate, useUpdate } from "../lib/update";
import { ChangelogDialog } from "./ChangelogDialog";
import { ChooseCourses } from "./ChooseCourses";
import { Button, Dialog } from "./Dialog";
import { LanguagePicker } from "./LanguagePicker";
import { updateSaying } from "./VersionLine";
import { switchAccount } from "./Setup";
import { SignInDialog, inputClass } from "./SignIn";

const AUTO_SYNC: [number, string][] = [
  [0, t("Never")], [30, t("Every 30 minutes")], [60, t("Every hour")], [180, t("Every 3 hours")], [360, t("Every 6 hours")], [1440, t("Every day")],
];

export function Settings({ account, sync, onSync, onAccount }: {
  account: AccountInfo | null; // the main window's (signing in again happens there too)
  sync: SyncState | null;
  onSync: () => void;
  onAccount: (a: AccountInfo) => void; // signed in or out
}) {
  const [check, setCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [signingIn, setSigningIn] = useState(false); // again, to this account (SignInDialog)
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
  /** Switching account or school: signed out, then the window goes to signing in (Setup.tsx),
   * from its first step, with no way back to this account but signing in to it. */
  const switchNow = async () => {
    setSwitching(false);
    if (!account) return;
    try {
      if (account.auth === "session") await api.canvasLogout();
      changed(await api.signOut());
      switchAccount(account);
    } catch (e) {
      setError(friendly((e as Error).message));
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

        <Section title={t("Account")}>
          {account && (
            <>
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-selected text-sm font-semibold text-accent">
                  {(account.user ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{account.user ?? t("Canvas user")}</p>
                  <p className="truncate text-xs text-muted">{account.base_url?.replace(/^https?:\/\//, "")}</p>
                </div>
                <AccountStatus account={account} check={check} />
              </div>
              <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
                <Button onClick={() => setSigningIn(true)}>{account.signed_in ? t("Sign in again…") : t("Sign in…")}</Button>
                {account.signed_in && <Button onClick={() => setConfirmSignOut(true)}>{t("Sign out…")}</Button>}
                <Button onClick={() => setSwitching(true)} disabled={!!sync?.running}>{t("Switch account or school…")}</Button>
              </div>
              <Row label={t("Sync folder")} hint={t("Where your course files are.")}>
                <span className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 truncate text-xs" title={account.root ?? ""}>{account.root}</code>
                  <button title={t("Open in {app}", { app: fileManager })} onClick={() => void api.openPath("")}
                    className="shrink-0 rounded p-1 text-muted hover:bg-chip hover:text-fg">
                    <FolderOpen className="size-4" />
                  </button>
                  <Button onClick={() => setMoving(true)} disabled={!!sync?.running} className="shrink-0 px-2.5! py-1! text-xs!">
                    {t("Move…")}
                  </Button>
                </span>
              </Row>
            </>
          )}
        </Section>

        {account?.set_up && <EdSection syncing={!!sync?.running} />}

        <Section title={t("Sync")}>
          {prefs && (
            <>
              <Row label={t("Sync automatically")} hint={t("While the app is running or in background, it syncs from Canvas this often.")}>
                <select value={prefs.auto_sync} onChange={(e) => void update({ auto_sync: Number(e.target.value) })}
                  className="rounded-md border border-line bg-bg px-2 py-1 text-sm">
                  {AUTO_SYNC.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
                </select>
              </Row>
              <Row label={t("Sync when the app opens")} hint={t("If the last sync was more than 10 minutes ago.")}>
                <Toggle on={prefs.sync_on_launch} onChange={(v) => void update({ sync_on_launch: v })} />
              </Row>
              <Row label={t("Courses to sync")}>
                <Button onClick={() => setChoosing(true)} disabled={!account?.signed_in}>{t("Choose Courses…")}</Button>
              </Row>
              <Row label={t("Last synced")}>
                <span className="flex items-center gap-3 text-sm">
                  <span className="text-muted">{sync?.running ? t("Syncing…") : last ? shortDate(last) : t("Never@@synced")}</span>
                  <Button onClick={onSync} disabled={!!sync?.running || !account?.signed_in} className="flex items-center gap-1.5">
                    <RefreshCw className="size-3.5" />{t("Sync now")}
                  </Button>
                </span>
              </Row>
            </>
          )}
        </Section>

        <Section title={t("General")}>
          <Row label={t("Language")}>
            <LanguagePicker />
          </Row>
        </Section>

        <Section title={t("Search")}>
          <LauncherKeysRow />
          <MeaningRow />
        </Section>

        {account?.set_up && <AssistantSection />}

        <Section title={t("Advanced")}>
          <Row label={t("Edit advanced sync rules")}>
            <Button onClick={() => void api.openConfig().catch((e) => setError(friendly(e.message)))}>{t("Open config file")}</Button>
          </Row>
          <VersionRow />
        </Section>
      </div>

      {confirmSignOut && (
        <Dialog
          title={t("Sign out?")}
          onClose={() => setConfirmSignOut(false)}
          footer={
            <>
              <Button onClick={() => setConfirmSignOut(false)}>{t("Cancel")}</Button>
              <Button danger autoFocus onClick={() => void signOut()}>{t("Sign out")}</Button>
            </>
          }
        >
          <p className="text-fg-soft">{account?.auth === "session"
            ? t("Your Canvas sign-in saved on this computer will be deleted, and syncing and external tools will stop working. Downloaded files, pinned items and settings stay, and pick up where they left off when you sign in again.")
            : t("The token saved on this computer is deleted, so nothing syncs and external tools won't open. Downloaded files, pins and settings stay, ready for when you sign in again.")}</p>
        </Dialog>
      )}
      {choosing && (
        <Dialog title={t("Courses to sync")} onClose={() => setChoosing(false)}>
          <div className="pb-3">
            <ChooseCourses
              submitLabel={t("Save")}
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
      {signingIn && account && (
        <SignInDialog account={account} onClose={() => setSigningIn(false)}
          onDone={(a) => (setSigningIn(false), changed(a), setCheck({ ok: true }))} />
      )}
      {switching && (
        <Dialog
          title={t("Switch account or school?")}
          onClose={() => setSwitching(false)}
          footer={
            <>
              <Button onClick={() => setSwitching(false)}>{t("Cancel")}</Button>
              <Button primary autoFocus onClick={() => void switchNow()}>{t("Switch")}</Button>
            </>
          }
        >
          <p className="text-fg-soft">{t("You'll be signed out of this account. Downloaded files and settings stay in the current sync folder.")}</p>
        </Dialog>
      )}
    </div>
  );
}

function AccountStatus({ account, check }: { account: AccountInfo; check: { ok: boolean; error?: string } | null }) {
  if (!account.signed_in) {
    return <span className="flex shrink-0 items-center gap-1 text-xs text-muted"><CircleAlert className="size-3.5" />{t("Signed out@@none")}</span>;
  }
  if (!check) return <span className="shrink-0 text-xs text-muted">{t("Checking…")}</span>;
  if (check.ok) return <span className="flex shrink-0 items-center gap-1 text-xs text-ok"><CheckCircle2 className="size-3.5" />{t("Signed in")}</span>;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-danger" title={friendly(check.error ?? "")}>
      <CircleAlert className="size-3.5" />
      {/sign-in rejected/.test(check.error ?? "") ? t("Signed out") : /token/.test(check.error ?? "") ? t("Token expired") : t("Can't reach Canvas")}
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
              <p className="truncate text-sm font-medium">{state.user ?? t("Ed user")}</p>
              <p className="truncate text-xs text-muted">
                {state.error ? <span className="text-danger">{edSaying(state.error)}</span>
                  : state.ok_at ? t("Last synced {when}", { when: shortDate(state.ok_at) }) : "edstem.org"}
              </p>
            </div>
            {state.error
              ? <span className="flex shrink-0 items-center gap-1 text-xs text-danger"><CircleAlert className="size-3.5" />{t("Something's wrong")}</span>
              : <span className="flex shrink-0 items-center gap-1 text-xs text-ok"><CheckCircle2 className="size-3.5" />{t("Connected")}</span>}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
            <Button onClick={() => setToken("")}>{t("Replace token…")}</Button>
            <Button onClick={() => act(api.disconnectEd())}>{t("Disconnect")}</Button>
          </div>
        </>
      ) : token === null ? (
        <Row label="Ed Discussion" hint={t("Once connected, each course's announcements and posts on Ed show up in the course. Read-only: nothing is posted for you or marked as read.")}>
          <Button onClick={() => setToken("")}>{t("Connect…")}</Button>
        </Row>
      ) : (
        <div className="px-4 py-3">
          <p className="mb-2 text-xs text-muted">{t("Create a token on Ed's “Settings → API Tokens” page and paste it here.")}</p>
          <div className="flex gap-2">
            <input type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("Paste the token")}
              autoComplete="off" spellCheck={false} className={inputClass} onKeyDown={(e) => e.key === "Enter" && !busy && void connect()} />
            <Button onClick={() => (setToken(null), setError(null))}>{t("Cancel")}</Button>
            <Button primary disabled={!token.trim() || busy} onClick={() => void connect()}>{busy ? t("Connecting…") : t("Connect")}</Button>
          </div>
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          <button onClick={() => void api.openExternal(state.token_page)} className="mt-2 text-xs text-accent hover:underline">
            {t("Open Ed's token page")}
          </button>
        </div>
      )}
      {state.courses.length > 0 && (
        <div className="px-4 py-3">
          <p className="text-sm">{t("Courses")}</p>
          <p className="mt-0.5 mb-2 text-xs leading-relaxed text-muted">{t("Select which Canvas course each Ed course links to.")}</p>
          <div className="space-y-1.5">
            {[...linked, ...(showAll ? others : [])].map((c) => (
              <div key={c.id} className={`flex items-center gap-3 ${c.archived && c.course === null ? "opacity-60" : ""}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{c.code || c.name}</p>
                  <p className="truncate text-xs text-muted">{[c.code && c.name !== c.code ? c.name : "", c.term].filter(Boolean).join(" · ")}</p>
                </div>
                <select value={c.course ?? ""} onChange={(e) => act(api.linkEd(c.id, e.target.value ? Number(e.target.value) : null))}
                  className="max-w-56 min-w-0 shrink rounded-md border border-line bg-bg px-2 py-1 text-sm">
                  <option value="">{t("None of your courses")}</option>
                  {canvas.map((x) => <option key={x.id} value={x.id}>{x.term ? `${x.label} · ${x.term}` : x.label}</option>)}
                </select>
              </div>
            ))}
          </div>
          {others.length > 0 && (
            <button onClick={() => setShowAll(!showAll)} className="mt-2 text-xs text-accent hover:underline">
              {showAll ? t("Only the matched ones") : tn("1 more Ed course that isn't one of your courses", "{n} more Ed courses that aren't any of your courses", { n: others.length })}
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

/** Version: this one, and Check for updates (which the app also does by itself now and then). */
function VersionRow() {
  const [version, setVersion] = useState("");
  const update = useUpdate();
  useEffect(() => void getVersion().then(setVersion, () => {}), []);
  const status = update.phase === "failed" ? null : updateSaying(update);
  const available = update.phase === "available" && update.notes.length ? update : null;
  const [changelog, setChangelog] = useState(false);
  // (The hint is a <p>: what's new is in spans, a line each.)
  return (
    <Row label={t("Version")} hint={version ? (
      <>
        <span className="tabular-nums">{version}</span>
        {" · "}
        <button onClick={() => setChangelog(true)} className="text-accent hover:underline">{t("Changelog")}</button>
        {available && (
          <span className="mt-1.5 block text-fg-soft">
            {t("What's new in {v}:", { v: available.version })}
            {available.notes.map((n, i) => <span key={i} className="mt-0.5 flex gap-1.5"><span>•</span><span>{n}</span></span>)}
          </span>
        )}
      </>
    ) : undefined}>
      <span className="flex items-center gap-3 text-sm">
        {update.phase === "failed"
          ? <span className="flex items-center gap-1 text-xs text-danger" title={update.error}><CircleAlert className="size-3.5" />{updateSaying(update)}</span>
          : status && <span className={update.phase === "available" ? "text-accent" : "text-muted"}>{status}</span>}
        {update.phase === "available" || (update.phase === "failed" && update.version)
          ? <Button onClick={() => void installUpdate()}>{t("Update and restart")}</Button>
          : <Button onClick={() => void checkForUpdate()} disabled={update.phase === "checking" || update.phase === "downloading" || update.phase === "installing"}>{t("Check for updates")}</Button>}
      </span>
      {changelog && <ChangelogDialog onClose={() => setChangelog(false)} />}
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
    ?? (state.phase === "downloading" ? t("Downloading the model… {pct}%", { pct })
      : state.phase === "indexing" && state.total ? t("Going through the text… {done}/{total}", { done: state.done, total: state.total })
      : state.phase === "failed" ? t("Couldn't get it ready: {error}", { error: friendly(state.error) })
      : null);
  return (
    <Row
      label={t("Search text by meaning")}
      hint={
        <>
          {t("Makes searching smarter by using a small language model (125 MB, downloaded when you turn this on).")}
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
    const picked = await open({ directory: true, title: t("Choose a sync folder") });
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
      <Dialog title={t("Move sync folder")} onClose={stay}
        footer={<Button primary onClick={() => location.reload()}>{t("Done@@button")}</Button>}>
        <p className="mb-2 text-fg-soft [overflow-wrap:anywhere] select-text">
          {t("Your files have moved, but the old folder couldn't be fully deleted. You can delete it yourself: {path}", { path: leftBehind })}
        </p>
      </Dialog>
    );
  }
  return (
    <Dialog title={t("Move sync folder")} onClose={busy ? stay : onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
          <Button primary disabled={busy || !target} onClick={() => void go()}>
            {busy ? t("Moving…") : t("Move")}
          </Button>
        </>
      }>
      <p className="mb-1 font-medium">{t("Current location")}</p>
      <code className="mb-3 block truncate rounded-md border border-line bg-chip px-2.5 py-1.5" title={root}>{root}</code>
      <p className="mb-1 font-medium">{t("Move to")}</p>
      <div className="flex gap-2">
        <code className={`min-w-0 flex-1 truncate rounded-md border border-line bg-chip px-2.5 py-1.5 ${target ? "" : "font-sans text-muted"}`} title={target}>
          {target || t("None chosen yet")}
        </code>
        <Button disabled={busy} onClick={() => void choose()}>{t("Choose…")}</Button>
      </div>
      <p className="mt-1.5 mb-3 text-xs text-muted">{t("Choose an empty folder. All your course files and settings move there, with nothing to download again.")}</p>
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
    <Section title={t("AI assistants")}>
      <div className="px-4 py-3">
        <p className="text-sm">{t("Link an external AI app")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("Allow external AI apps (such as ChatGPT or Claude) to search and read your synced course content.")}</p>
      </div>
      {apps && installed.length === 0 && <p className="px-4 py-3 text-sm text-muted">{t("No supported AI app found on this computer.")}</p>}
      {installed.map((a) => {
        const note = errors[a.id]
          ?? (added.has(a.id) && a.added
            ? (a.restart ? t("Ready once you reopen {app}.", { app: a.name }) : t("Ready in new conversations in {app}.", { app: a.name }))
            : a.added && !a.current ? t("Set up with another copy of Canvas Sync.") : null);
        return (
          <Row key={a.id}
            label={
              <span className="flex items-center gap-1.5">
                {a.name}
                {a.added && (a.current
                  ? <CheckCircle2 className="size-3.5 text-ok" aria-label={t("Linked")} />
                  : <CircleQuestionMark className="size-3.5 text-warn" aria-label={t("Set up with another copy of Canvas Sync.")} />)}
              </span>
            }
            hint={note && <span className={errors[a.id] ? "text-danger" : ""}>{note}</span>}>
            {a.added && a.current
              ? <Button disabled={busy !== null} onClick={() => void ask(a, false)}>{t("Unlink…")}</Button>
              : <Button disabled={busy !== null} onClick={() => void ask(a, true)}>
                  {a.added ? t("Use This One…") : t("Link…")}
                </Button>}
          </Row>
        );
      })}
      {how && servers && (
        <details className="px-4 py-3">
          <summary className="cursor-default text-xs text-muted select-none hover:text-fg">{t("Add to another app by hand")}</summary>
          <div className="mt-3 space-y-4">
            <Copyable label={t("Config")} hint={t("Most apps' MCP settings take this:")}
              text={JSON.stringify({ mcpServers: servers }, null, 2)} />
            <Copyable label={t("Command")} hint={t("For apps that ask only for a command:")} text={`"${how.command}" ${how.args.join(" ")}`} />
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
      title={action === "add" ? t("Let {app} read your courses?", { app: app.name })
        : action === "replace" ? t("Switch {app} to this copy of Canvas Sync?", { app: app.name })
        : t("Stop {app} from reading your courses?", { app: app.name })}
      onClose={busy ? stay : onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
          <Button primary autoFocus disabled={busy} onClick={() => void go()}>
            {action === "add" ? t("Link") : action === "replace" ? t("Use This One") : t("Unlink")}
          </Button>
        </>
      }
    >
      <div className="mb-3 space-y-2 text-fg-soft">
        <p>
          {action === "add" ? t("{app} will be able to search and read your synced courses, but not change anything.", { app: app.name })
            : action === "replace" ? t("{app} is connected to another copy of Canvas Sync (an older version, for example). It will disconnect from the other Canvas Sync and connect to the one you're using now.", { app: app.name })
            : t("{app} won't be able to read your courses anymore. Your courses and files aren't affected.", { app: app.name })}
        </p>
        <p>
          {action === "remove" ? t("Canvas Sync will delete the connection details from {app}'s settings file. Your other settings stay the same, and the file is backed up first.", { app: app.name })
            : !preview.exists ? t("To do this, Canvas Sync will create a settings file for {app}, with only the connection details in it.", { app: app.name })
            : action === "replace" ? t("To do this, Canvas Sync will change {app}'s settings file, updating only the connection details. Your other settings stay the same, and the file is backed up first.", { app: app.name })
            : t("To do this, Canvas Sync will change {app}'s settings file, adding the connection details. Your other settings stay the same, and the file is backed up first.", { app: app.name })}
        </p>
      </div>
      <details className="mb-3">
        <summary className="cursor-default text-xs text-muted select-none hover:text-fg">{t("See the exact changes")}</summary>
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium">{preview.exists ? t("Config file to change:") : t("Config file to create:")}</p>
          <pre className="mb-3 rounded-md border border-line bg-chip px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
            {preview.path}
          </pre>
          <p className="mb-1.5 text-xs font-medium">
            {action === "add" ? t("Adds this entry to {key}:", { key })
              : action === "replace" ? t("Replaces this entry in {key}:", { key })
              : t("Deletes this entry from {key}:", { key })}
          </p>
          <pre className="mb-3 rounded-md border border-line bg-chip px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
            {lines(preview.removed, "-", "text-danger")}
            {lines(preview.added, "+", "text-ok")}
          </pre>
          <div className="space-y-1 text-xs text-muted [overflow-wrap:anywhere] select-text">
            {preview.backup && <p>{t("The file is first backed up to {path} (only the latest backup is kept).", { path: preview.backup })}</p>}
            {action !== "remove" && <p>{t("If Canvas Sync moves later, it updates this entry on its own.")}</p>}
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
          {copied ? t("Copied") : t("Copy")}
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
      if (got === "no modifier") return setError(isMac ? t("Include ⌘, ⌃ or ⌥.") : t("Include Ctrl, Alt or Win."));
      chose = true;
      setListening(false);
      void chooseLauncherKeys(got).then(() => setError(null), (err) => {
        setError(t("These keys can't be used (another app may have them): {why}", { why: friendly(String((err as Error)?.message ?? err)) }));
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
      label={t("Quick search shortcut")}
      hint={
        <>
          {t("Press this in any app to open the search window. Click it, then press new keys to change it.")}
          {error && <span className="mt-1 block text-danger">{error}</span>}
        </>
      }
    >
      <span className="flex items-center gap-2">
        {keys && !listening && (
          <button onClick={() => void chooseLauncherKeys("").then(() => setError(null), () => {})} className="text-xs text-accent hover:underline">
            {t("Reset")}
          </button>
        )}
        <button
          onClick={() => (setError(null), setListening(!listening))}
          className={`min-w-24 rounded border px-2 py-0.5 text-xs ${listening ? "border-accent bg-selected text-accent" : "border-line bg-chip hover:border-fg-soft"}`}
        >
          {listening ? t("Press keys…") : keysLabel(keys)}
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
