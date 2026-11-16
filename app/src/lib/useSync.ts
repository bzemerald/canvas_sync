// The sync, as the main window follows it: where it's got to (asked often while one runs, now and
// then otherwise: the backend syncs by itself too, Settings → Sync automatically), starting one,
// whether the sign-in still works (asked as the window opens), and signing in again quietly when
// a browser sign-in has expired.
import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { AccountInfo, Scope, SyncState } from "./api";

export function useSync({ account, onAccount, onFinished, signIn }: {
  account: AccountInfo | null;
  onAccount: (a: AccountInfo) => void; // signed in again
  onFinished: () => void; // a sync ended: what it changed is to be loaded again
  signIn: (site: string) => Promise<Record<string, string>>; // in a hidden window, if nothing needs typing: its cookies
}) {
  const [sync, setSync] = useState<SyncState | null>(null);
  const [label, setLabel] = useState(""); // what the sync shown is of
  const finished = useRef<string | null>(null); // when the sync we last reloaded for ended
  const done = useRef(onFinished);
  done.current = onFinished;
  useEffect(() => {
    void api.syncState().then((s) => {
      finished.current = s.finished_at;
      setSync(s);
    }, () => {});
  }, []);
  // While a sync runs, poll its progress; when it ends, reload what it changed. Otherwise look
  // now and then.
  useEffect(() => {
    const timer = setInterval(async () => {
      const next = await api.syncState().catch(() => null);
      if (!next) return;
      setSync(next);
      if (!next.running && next.finished_at !== finished.current) {
        finished.current = next.finished_at;
        done.current();
      }
    }, sync?.running ? 500 : 15000);
    return () => clearInterval(timer);
  }, [sync?.running]);

  /** Starts one (signed in). Whether it started: not if one is already running (that one is shown). */
  const run = async (scope: Scope, label: string): Promise<boolean> => {
    try {
      const started = await api.startSync(scope);
      setLabel(label);
      setSync(started);
      return true;
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) { // (one started since the menu opened)
        void api.syncState().then(setSync, () => {});
        return false;
      }
      setLabel(label);
      setSync({ phase: "failed", scope: [], running: false, errors: [String((e as Error).message)], warnings: [], total: 0, done: 0, current: "", changes: {}, finished_at: null, ed_error: null });
      return false;
    }
  };

  // The browser sign-in expired: signed in again in a hidden window, if the school still knows
  // you, and what failed syncs again. Once per sync that failed so, and not again for the sync
  // that started (it failing so too, quietly signing in doesn't do): then it's for the window to
  // offer signing in.
  const [renewing, setRenewing] = useState(false);
  const renewedFor = useRef<string | null>(null);
  const renewedSync = useRef(false); // the sync now (or last) was started by signing in quietly
  useEffect(() => {
    if (sync?.finished_at && !sync.expired) renewedSync.current = false; // (it ended otherwise)
    if (!sync?.expired || account?.auth !== "session" || !account.base_url || renewedFor.current === sync.finished_at) return;
    renewedFor.current = sync.finished_at;
    if (renewedSync.current) return void (renewedSync.current = false);
    const failed = sync;
    setRenewing(true);
    void signIn(account.base_url)
      .then((cookies) => api.replaceCredentials({ cookies }))
      .then((a) => {
        onAccount(a);
        renewedSync.current = true;
        void run(failed.scope.length ? { paths: failed.scope } : {}, label);
      }, () => {})
      .finally(() => setRenewing(false));
  }, [sync?.expired, sync?.finished_at, account?.auth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether Canvas still takes the sign-in, asked as the window opens (and again once you've signed
  // in again), not left for the next sync to find out. An expired browser sign-in is renewed
  // quietly first, as after a sync; once a run of the app (it failing, the window says so).
  const [stale, setStale] = useState(false);
  const renewedAtCheck = useRef(false);
  useEffect(() => {
    if (!account?.signed_in || !account.base_url) return;
    let live = true;
    void api.checkAccount().then(async (c) => {
      const expired = !c.ok && /rejected/.test(c.error ?? ""); // (not "can't reach the site": offline, say)
      if (live && expired && account.auth === "session" && !renewedAtCheck.current) {
        renewedAtCheck.current = true;
        setRenewing(true);
        try {
          const a = await api.replaceCredentials({ cookies: await signIn(account.base_url!) });
          if (live) return void onAccount(a); // (asked again, for the new sign-in)
        } catch {
          // (It needs typing: the window says so.)
        } finally {
          setRenewing(false);
        }
      }
      if (live) setStale(expired);
    }, () => {});
    return () => void (live = false);
  }, [account]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sync?.phase === "done") setStale(false); // (a sync got through: it's fine)
  }, [sync?.phase, sync?.finished_at]);

  return { sync, label, busy: !!sync?.running, run, renewing, stale: stale && !sync?.expired };
}
