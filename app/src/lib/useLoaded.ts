// What a view loads from the backend, remembered: coming back to it draws what it had at once,
// and reloading it (after a sync, or the window coming back to the front) keeps that on screen
// until the new answer is in, instead of a flash of 正在加载….
import { useEffect, useState } from "react";

const remembered = new Map<string, unknown>();

/** Change what's remembered for `key` (what was typed in a note, say). */
export const remember = (key: string, value: unknown) => void remembered.set(key, value);

/** `load()` for `key` (null: nothing to load), again whenever `again` changes. `value` is
 * undefined until there's an answer, the last one remembered for `key` if any. */
export function useLoaded<T>(key: string | null, load: () => Promise<T>, again: unknown[] = []): { value: T | undefined; error: Error | null } {
  const [state, setState] = useState<{ key: string | null; value?: T; error?: Error }>({ key: null });
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
  }, [key, ...again]);
  if (key === null) return { value: undefined, error: null };
  if (state.key === key) return { value: state.error ? undefined : state.value, error: state.error ?? null };
  return { value: remembered.get(key) as T | undefined, error: null };
}
