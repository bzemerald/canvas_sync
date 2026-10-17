import { useEffect, useState } from "react";
import type { Hit } from "./api";

/** Debounced search that ignores responses to queries the user has already typed past. */
export function useSearch(query: string, run: (q: string) => Promise<Hit[]>, deps: unknown[] = [], delay = 120) {
  const { answer: hits, error, loading } = useAnswer(query, run, NO_HITS, deps, delay);
  return { hits, error, loading };
}
const NO_HITS: Hit[] = [];

/** What `run` answers for `query`, debounced; answers to queries typed past are dropped. */
export function useAnswer<T>(query: string, run: (q: string) => Promise<T>, initial: T, deps: unknown[] = [], delay = 120) {
  const [answer, setAnswer] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await run(query);
        if (!stale) {
          setAnswer(result);
          setError(null);
        }
      } catch (e) {
        if (!stale) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stale) setLoading(false);
      }
    }, query ? delay : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ...deps]);

  return { answer, error, loading };
}
