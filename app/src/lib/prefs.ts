import { useState } from "react";

/** A per-device UI preference (view mode and the like). Storage can be unavailable; then it just isn't remembered. */
export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`pref:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(`pref:${key}`, JSON.stringify(v));
    } catch {
      /* not remembered */
    }
  };
  return [value, set];
}
