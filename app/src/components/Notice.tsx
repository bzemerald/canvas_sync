// The message at the bottom of the window: what just happened, and 撤销 where it can be undone.
import { useEffect, useRef } from "react";

/** What to do about a notice, from it: 撤销, say. */
export type NoticeAction = { label: string; run: () => void };
export type NoticeState = { text: string; action?: NoticeAction };

/** A short message at the bottom of the window that goes away by itself (a little later when
 * there's something to do about it). */
export function Notice({ notice, onDone }: { notice: NoticeState | null; onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => done.current(), notice.action ? 8000 : 5000); // per message, not per re-render
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-lg border border-line bg-panel px-4 py-2 text-sm shadow-xl">
      {notice.text}
      {notice.action && (
        <button
          onClick={() => {
            notice.action!.run();
            done.current();
          }}
          className="shrink-0 font-medium text-accent hover:underline"
        >
          {notice.action.label}
        </button>
      )}
    </div>
  );
}
