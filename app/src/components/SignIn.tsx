// Connecting a Canvas account: the school's Canvas address, how to sign in (in a Canvas window
// of the app's, or with an access token, which some schools don't allow), and where the files go. What a new user sees first; in Settings, how you switch account or school.
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { AccountInfo } from "../lib/api";
import { friendly } from "../lib/errors";
import { t, tn, tx } from "../lib/i18n";
import { Button, Dialog } from "./Dialog";

/** How to make a Canvas token, when signing in and when replacing one. */
export const tokenSteps = () => t("In Canvas: Account → Settings → Approved Integrations → “+ New Access Token”. Set “Purpose” to Canvas Sync and paste the token here. Make a new one when it expires.");

/** Sign in in the app's Canvas window: its cookies (an error "cancelled" if it was closed). */
export const browserSignIn = (site: string, silent = false) => api.canvasLogin(site, t("Sign in to Canvas"), silent);

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

type Step = "folder" | "site" | "auth";
const STEPS: Step[] = ["folder", "site", "auth"]; // (signing in last: it's what sets it all up)

/** How far a sign-in got (not the token: that's never kept). */
export type Progress = { step: Step; url: string; how: "browser" | "token"; root: string };

/** Which step a sign-in's error is about, to go back there. */
function stepOf(message: string): Step {
  if (/folder|not a sync folder/.test(message)) return "folder";
  if (/web address|https only|reach the site|not a Canvas site/.test(message)) return "site";
  return "auth";
}

/** Signing in, a step at a time: the sync folder, the school's Canvas, how to sign in. Where it
 * starts is `seed`; how far it gets goes to `onProgress` (Setup.tsx keeps it, for coming back). */
export function SignInForm({ another, seed, onProgress, submitLabel, onDone, onCancel }: {
  another?: boolean; // switching from the account there is
  seed?: Partial<Progress>;
  onProgress?: (p: Progress) => void;
  submitLabel?: string;
  onDone: (account: AccountInfo) => void;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<Step>(seed?.step ?? "folder");
  const [url, setUrl] = useState(seed?.url ?? "");
  const [how, setHow] = useState<"browser" | "token">(seed?.how ?? "token");
  const [token, setToken] = useState("");
  const [root, setRoot] = useState(seed?.root ?? "~/Canvas");
  useEffect(() => onProgress?.({ step, url, how, root }), [step, url, how, root]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const site = siteOf(url);
  const at = STEPS.indexOf(step);
  const go = (to: Step) => (setError(null), setStep(to));

  const choose = async () => {
    const picked = await open({ directory: true, title: t("Choose a sync folder"), defaultPath: !root || root.startsWith("~") ? undefined : root });
    if (typeof picked === "string") setRoot(picked);
  };
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const cred = how === "token" ? { token } : { cookies: await browserSignIn(site ?? "") };
      onDone(await api.setUp(url, cred, root));
    } catch (err) {
      if (cancelled(err)) return;
      const message = (err as Error).message;
      setStep(stepOf(message));
      setError(friendly(message));
    } finally {
      setBusy(false);
    }
  };
  const ready = step === "folder" ? !!root : step === "site" ? !!site : how === "browser" || !!token.trim();
  const next = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    if (step === "auth") void signIn();
    else go(STEPS[at + 1]);
  };

  return (
    <form onSubmit={next} className="space-y-4 text-sm">
      <p className="text-xs text-muted">{tn("Step 1 of 3", "Step {n} of 3", { n: at + 1 })}</p>
      {step === "folder" && (
        <div>
          <span className="mb-1 block font-medium">{t("Choose a sync folder")}</span>
          <div className="flex gap-2">
            <code className={`min-w-0 flex-1 truncate rounded-md border border-line bg-chip px-2.5 py-1.5 ${root ? "" : "font-sans text-muted"}`} title={root}>
              {root || t("None chosen yet")}
            </code>
            <Button type="button" autoFocus onClick={() => void choose()}>{t("Choose…")}</Button>
          </div>
          <span className="mt-1.5 block text-xs text-muted">
            {another
              ? t("For another school, choose a new sync folder.")
              : t("Course files download here. Choose an empty folder if it's your first time using Canvas Sync.")}
          </span>
        </div>
      )}
      {step === "site" && (
        <label className="block">
          <span className="mb-1 block font-medium">{t("Your school's Canvas address")}</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("e.g. bcourses.berkeley.edu")} autoFocus
            spellCheck={false} autoCapitalize="off" className={inputClass} />
        </label>
      )}
      {step === "auth" && <AuthChoice how={how} setHow={(h) => (setHow(h), setError(null))} token={token} setToken={setToken} site={site} />}
      {error && <p className="text-danger">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && <Button type="button" onClick={onCancel} className="mr-auto">{t("Cancel")}</Button>}
        {at > 0 && <Button type="button" disabled={busy} onClick={() => go(STEPS[at - 1])}>{t("Back")}</Button>}
        <Button primary type="submit" disabled={busy || !ready}>
          {busy ? t("Signing in…") : step !== "auth" ? t("Next") : how === "browser" ? t("Open the sign-in page…") : submitLabel ?? t("Sign in")}
        </Button>
      </div>
    </form>
  );
}

type How = "browser" | "token";

/** How to sign in: a token pasted, or the school's sign-in page in a window. */
function AuthChoice({ how, setHow, token, setToken, site }: {
  how: How;
  setHow: (h: How) => void;
  token: string;
  setToken: (t: string) => void;
  site: string | null; // (for the link to where tokens are made)
}) {
  return (
    <div>
      <span className="mb-1 block font-medium">{t("Sign in with")}</span>
      <div className="flex rounded-md border border-line p-0.5" role="radiogroup">
        {([["token", t("Access token")], ["browser", t("Sign-in page")]] as const).map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={how === k} onClick={() => setHow(k)}
            className={`flex-1 rounded px-2 py-1 text-xs ${how === k ? "bg-selected font-medium text-accent" : "text-muted hover:text-fg"}`}>
            {label}
          </button>
        ))}
      </div>
      {how === "browser" ? (
        <span className="mt-1.5 block text-xs leading-relaxed text-muted">
          {t("Complete sign-in in the window that opens.")}
        </span>
      ) : (
        <>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("Paste the token")} autoFocus
            autoComplete="off" spellCheck={false} className={`${inputClass} mt-2`} />
          <span className="mt-1.5 block text-xs leading-relaxed text-muted">
            {tokenSteps()}
            {site && (
              <button type="button" onClick={() => void api.openExternal(`${site}/profile/settings`)} className="ml-1 text-accent hover:underline">
                {t("Open Canvas settings")}
              </button>
            )}
          </span>
          <span className="mt-1.5 block text-xs leading-relaxed text-muted">
            {tx("Some schools don't let students create access tokens. If yours doesn't, sign in with the {page} instead.", {
              page: <button type="button" onClick={() => setHow("browser")} className="text-accent hover:underline">{t("sign-in page")}</button>,
            })}
          </span>
        </>
      )}
    </div>
  );
}

/** Signing in again to the same account (signed out, or the sign-in expired): only how. */
export function SignInDialog({ account, onDone, onClose }: {
  account: AccountInfo;
  onDone: (account: AccountInfo) => void;
  onClose: () => void;
}) {
  const [how, setHow] = useState<How>(account.auth === "session" ? "browser" : "token");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const site = account.base_url;
  const ready = how === "browser" || !!token.trim();
  const signIn = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready || busy || !site) return;
    setBusy(true);
    setError(null);
    try {
      const cred = how === "token" ? { token } : { cookies: await browserSignIn(site) };
      onDone(await api.replaceCredentials(cred));
    } catch (err) {
      if (!cancelled(err)) setError(friendly((err as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("Sign in to Canvas")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} className="mr-auto">{t("Cancel")}</Button>
          <Button primary disabled={busy || !ready} onClick={() => void signIn()}>
            {busy ? t("Signing in…") : how === "browser" ? t("Open the sign-in page…") : t("Sign in")}
          </Button>
        </>
      }
    >
      <form onSubmit={signIn} className="space-y-4 pb-3 text-sm">
        <AuthChoice how={how} setHow={(h) => (setHow(h), setError(null))} token={token} setToken={setToken} site={site} />
        {error && <p className="text-danger">{error}</p>}
      </form>
    </Dialog>
  );
}
