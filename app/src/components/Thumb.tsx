import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { FileIcon, hasThumbnail } from "./FileIcon";

// A few at a time: each one may mean rendering a PDF page in the backend.
const MAX_PARALLEL = 4;
const cache = new Map<string, Promise<string | null>>();
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

function load(path: string, mtime: number | null, size: number): Promise<string | null> {
  const key = `${path}|${mtime}|${size}`; // an edited file gets a new key, so a new thumbnail
  let p = cache.get(key);
  if (!p) {
    p = inSlot(() => api.thumb(path, size)).catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** The file's preview once it scrolls into view; its icon until then (or if it has none). */
export function Thumb({ path, name, mtime, size, iconClass }: { path: string; name: string; mtime: number | null; size: number; iconClass: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const wanted = hasThumbnail(name);

  useEffect(() => {
    if (!wanted || !box.current) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "300px" });
    io.observe(box.current);
    return () => io.disconnect();
  }, [wanted]);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    load(path, mtime, size * 2).then((u) => live && setUrl(u)); // 2x for retina
    return () => {
      live = false;
    };
  }, [visible, path, mtime, size]);

  return (
    <div ref={box} className="flex items-center justify-center" style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" draggable={false} className="max-h-full max-w-full rounded-sm border border-line bg-white object-contain shadow-sm" />
      ) : (
        <FileIcon name={name} className={iconClass} />
      )}
    </div>
  );
}
