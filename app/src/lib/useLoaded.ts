// What a view loads from the backend, remembered: coming back to it draws what it had at once,
// and reloading it (after a sync, or the window coming back to the front) keeps that on screen
// until the new answer is in, instead of a flash of 正在加载….
//
// What changed is said with `reload(...)`: what follows it (`useReloads`, or `useLoaded` with
// `follow`) loads again, by key: "overview" is every `overview:<id>`; nothing named is everything.
import { useEffect, useState } from "react";

const remembered = new Map<string, unknown>();

/** Change what's remembered for `key` (what was typed in a note, say). */
export const remember = (key: string, value: unknown) => void remembered.set(key, value);

const following = new Set<{ key: string; again: () => void }>();

/** Whether `key` is among `changed`: one of them, or under one ("overview" has "overview:3"). */
export const among = (key: string, changed: string[]) =>
  changed.length === 0 || changed.some((c) => key === c || key.startsWith(c + ":"));

/** Something changed: what follows these keys loads again (no keys: everything). */
export function reload(...changed: string[]) {
  for (const f of [...following]) if (among(f.key, changed)) f.again();
}

/** A number that goes up whenever `key` is reloaded (null: never): a dependency to load again on. */
export function useReloads(key: string | null): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (key === null) return;
    const f = { key, again: () => setN((x) => x + 1) };
    following.add(f);
    return () => void following.delete(f);
  }, [key]);
  return n;
}

/** `load()` for `key` (null: nothing to load), again whenever `again` changes, and, with
 * `follow`, when `key` is reloaded. `value` is undefined until there's an answer, the last one
 * remembered for `key` if any. */
export function useLoaded<T>(key: string | null, load: () => Promise<T>, { again = [], follow = false }: { again?: unknown[]; follow?: boolean } = {}): { value: T | undefined; error: Error | null } {
  const [state, setState] = useState<{ key: string | null; value?: T; error?: Error }>({ key: null });
  const reloaded = useReloads(follow ? key : null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    load().then(
      (value) => {
        remembered.set(key, value);
        if (live) setState({ key, value });
      },
      (error: Error) => live && setState({ key, error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloaded, ...again]);
  if (key === null) return { value: undefined, error: null };
  if (state.key === key) return { value: state.error ? undefined : state.value, error: state.error ?? null };
  return { value: remembered.get(key) as T | undefined, error: null };
}
