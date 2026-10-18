import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { FileIcon, hasThumbnail } from "./FileIcon";

// A few at a time: each one may mean rendering a PDF page in the backend.
const MAX_PARALLEL = 4;
const cache = new Map<string, Promise<string | null>>();
const done = new Map<string, string | null>(); // the ones in: drawn on the first frame
const waiting: (() => void)[] = [];
let active = 0;

async function inSlot<T>(job: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((go) => waiting.push(go));
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const keyOf = (path: string, mtime: number | null, size: number) => `${path}|${mtime}|${size}`; // edited: a new key

/** Decoded before it's handed over, so it appears whole, at once. */
async function decoded(url: string | null): Promise<string | null> {
  if (url) {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
  }
  return url;
}

function load(path: string, mtime: number | null, size: number): Promise<string | null> {
  const key = keyOf(path, mtime, size);
  let p = cache.get(key);
  if (!p) {
    p = inSlot(() => api.thumb(path, size)).then(decoded).catch(() => null);
    p.then((url) => done.set(key, url));
    cache.set(key, p);
  }
  return p;
}

/** The file's preview once it scrolls into view (at once if it was made before). Until it's in,
 * an empty space rather than its icon, which would flash before the preview; the icon if it has
 * none. */
export function Thumb({ path, name, mtime, size, iconClass }: { path: string; name: string; mtime: number | null; size: number; iconClass: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const known = done.get(keyOf(path, mtime, size * 2));
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null);
  const url = known !== undefined ? known : loaded?.path === path ? loaded.url : undefined;
  const wanted = hasThumbnail(name) && known === undefined;

  useEffect(() => {
    if (!wanted || !box.current) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "300px" });
    io.observe(box.current);
    return () => io.disconnect();
  }, [wanted]);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    load(path, mtime, size * 2).then((u) => live && setLoaded({ path, url: u })); // 2x for retina
    return () => {
      live = false;
    };
  }, [visible, path, mtime, size]);

  return (
    <div ref={box} data-ql={path} className="flex items-center justify-center" style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" draggable={false} className="max-h-full max-w-full rounded-sm border border-line bg-white object-contain shadow-sm" />
      ) : url === null || !hasThumbnail(name) ? (
        <FileIcon name={name} className={iconClass} />
      ) : null}
    </div>
  );
}
