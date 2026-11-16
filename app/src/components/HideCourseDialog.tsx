import { useState } from "react";
import * as api from "../lib/api";
import type { Course } from "../lib/api";
import { friendly } from "../lib/errors";
import { t, tn } from "../lib/i18n";
import { Button, Dialog } from "./Dialog";

/** Hide a course you don't need to see (an orientation, a finished training), or a whole past
 * term, and usually stop syncing them too. They wait at the bottom of the sidebar, to bring back. */
export function HideCourseDialog({ courses, term, onClose, onDone }: {
  courses: Course[];
  term?: string; // hiding the whole term
  onClose: () => void;
  onDone: () => void;
}) {
  const [stopSyncing, setStopSyncing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const one = courses.length === 1 && !term;
  const hide = async () => {
    setBusy(true);
    try {
      await api.hideCourses(courses.map((c) => c.id), true, stopSyncing ? false : undefined);
      onDone();
    } catch (e) {
      setError(friendly((e as Error).message));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={one ? t("Hide “{name}”?", { name: courses[0].label }) : tn("Hide the 1 course in “{term}”?", "Hide the {n} courses in “{term}”?", { term: term ?? "", n: courses.length })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button primary autoFocus disabled={busy} onClick={() => void hide()}>{t("Hide")}</Button>
        </>
      }
    >
      <p className="text-fg-soft">
        {one
          ? t("It leaves the sidebar, search and what's new. You can bring it back anytime from “Hidden courses” at the bottom of the sidebar.")
          : t("They leave the sidebar, search and what's new. You can bring them back anytime from “Hidden courses” at the bottom of the sidebar.")}
      </p>
      {!one && <p className="mt-2 text-xs text-muted">{courses.map((c) => c.label).join(t(", "))}</p>}
      <label className="mt-3 flex items-start gap-2 text-fg-soft">
        <input type="checkbox" className="mt-1" checked={stopSyncing} onChange={(e) => setStopSyncing(e.target.checked)} />
        <span>
          {one ? t("Also stop syncing this course") : t("Also stop syncing these courses")}
          <span className="block text-xs text-muted">{t("Nothing new downloads from Canvas; the files you have stay where they are.")}</span>
        </span>
      </label>
      {error && <p className="mt-2 text-danger">{error}</p>}
    </Dialog>
  );
}
