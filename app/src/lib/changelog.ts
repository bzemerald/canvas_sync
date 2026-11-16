// What's new, by version: CHANGELOG.md (at the repo's top), built into the app. And whether this
// version is new since the app last ran (an update), for the sidebar to say so.
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import changelog from "../../../CHANGELOG.md?raw";

export type Release = { version: string; date: string; items: string[] };

/** A version's notes ("- " items, wrapped lines indented) as items: CHANGELOG.md's, or a release's
 * (its part of CHANGELOG.md, which Check for updates finds). */
export function noteItems(body: string | undefined): string[] {
  const items: string[] = [];
  for (const line of (body ?? "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (/^\s/.test(line) && items.length) items[items.length - 1] += " " + text;
    else items.push(text.replace(/^[-*]\s+/, ""));
  }
  return items;
}

/** The released versions, newest first ("## 0.4.0 — 2026-11-15"; not Unreleased, nor what's
 * before the first). */
export function releases(text: string = changelog): Release[] {
  return text.split(/^## /m).slice(1).flatMap((part) => {
    const [heading, ...body] = part.split(/\r?\n/);
    const m = /^(\d+\.\d+\.\d+)(?:\s+—\s+(\S+))?/.exec(heading.trim());
    return m ? [{ version: m[1], date: m[2] ?? "", items: noteItems(body.join("\n")) }] : [];
  });
}

/** Whether version a comes after b (both "major.minor.patch"). */
export function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const LAST = "lastVersion"; // the version that last ran, until an update to a newer one is seen

const stored = () => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};
const store = (v: string) => {
  try {
    localStorage.setItem(LAST, v);
  } catch {
    // (Not kept: nothing said after the next update.)
  }
};

/** After an update: the version it came from and this one, until dismissed. Null otherwise
 * (and on the first run, with nothing before it to have come from). */
export function useUpdated(): { from: string; to: string; dismiss: () => void } | null {
  const [seen, setSeen] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    void getVersion().then((to) => {
      const from = stored();
      if (from && newer(to, from)) setSeen({ from, to });
      else store(to);
    }, () => {});
  }, []);
  if (!seen) return null;
  return { ...seen, dismiss: () => (store(seen.to), setSeen(null)) };
}
