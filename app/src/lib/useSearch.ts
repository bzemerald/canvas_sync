import { useEffect, useState } from "react";
import type { Hit } from "./api";

/** Debounced search that ignores responses to queries the user has already typed past. */
export function useSearch(query: string, run: (q: string) => Promise<Hit[]>, deps: unknown[] = [], delay = 120) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await run(query);
        if (!stale) {
          setHits(result);
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

  return { hits, error, loading };
}
