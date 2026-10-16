// Choosing a course's icon: one of the app's, in a color, or any emoji; or none, or back to the
// app's pick from the course's subject.
import { useState } from "react";
import * as api from "../lib/api";
import type { Course } from "../lib/api";
import { COLORS, ICONS, IconView, iconFor, type IconChoice } from "../lib/courseIcons";
import { friendly } from "../lib/errors";
import { t } from "../lib/i18n";
import { Button, Dialog } from "./Dialog";

export function CourseIconDialog({ course, onClose, onDone }: { course: Course; onClose: () => void; onDone: () => void }) {
  const automatic = iconFor({ ...course, icon: null });
  const [choice, setChoice] = useState<IconChoice>(iconFor(course));
  const [auto, setAuto] = useState(!course.icon);
  const [error, setError] = useState<string | null>(null);
  const color = "color" in choice ? choice.color : "icon" in automatic ? automatic.color : "blue";
  const pick = (c: IconChoice) => {
    setChoice(c);
    setAuto(false);
  };

  const save = async () => {
    try {
      await api.setCourseIcon(course.id, auto ? null : "none" in choice ? { icon: "none" } : choice);
      onDone();
    } catch (e) {
      setError(friendly((e as Error).message));
    }
  };

  return (
    <Dialog
      title={t("更换“{name}”的图标", { name: course.label })}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <Button className="mr-auto" onClick={() => (setChoice(automatic), setAuto(true))} disabled={auto}>{t("自动")}</Button>
          <Button onClick={() => pick({ none: true })} disabled={"none" in choice}>{t("不显示图标")}</Button>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button primary onClick={() => void save()}>{t("保存")}</Button>
        </>
      }
    >
      <div className="mb-4 flex items-center gap-3 rounded-lg bg-chip px-3 py-2.5">
        <IconView choice={choice} size={24} />
        <span className="truncate font-medium">{course.label}</span>
        <span className="ml-auto shrink-0 text-xs text-muted">
          {auto ? t("自动选择（按课程科目）") : "none" in choice ? t("不显示图标") : ""}
        </span>
      </div>

      <h3 className="mb-1.5 text-xs text-muted">{t("图标@@heading")}</h3>
      <div className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1">
        {Object.keys(ICONS).map((name) => {
          const on = "icon" in choice && choice.icon === name;
          return (
            <button key={name} title={name} onClick={() => pick({ icon: name, color })}
              className={`flex aspect-square items-center justify-center rounded-md hover:bg-chip ${on ? "bg-selected ring-2 ring-accent" : ""}`}>
              <IconView choice={{ icon: name, color }} size={18} />
            </button>
          );
        })}
      </div>

      <h3 className="mb-1.5 text-xs text-muted">{t("颜色")}</h3>
      <div className="mb-4 flex flex-wrap gap-2">
        {Object.entries(COLORS).map(([name, value]) => (
          <button key={name} title={name} aria-label={name} onClick={() => pick({ icon: "icon" in choice ? choice.icon : "icon" in automatic ? automatic.icon : "book", color: name })}
            className={`size-6 rounded-full ${color === name && "icon" in choice ? "ring-2 ring-accent ring-offset-2 ring-offset-panel" : ""}`}
            style={{ background: value }} />
        ))}
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs text-muted">{t("或者用一个表情")}</span>
        <input
          value={"emoji" in choice ? choice.emoji : ""}
          onChange={(e) => {
            const emoji = [...e.target.value].slice(-2).join("").trim(); // the last one typed (some are two code points)
            if (emoji) pick({ emoji });
          }}
          placeholder="🧪"
          className="w-24 rounded-md border border-line bg-bg px-2.5 py-1.5 text-center text-lg outline-none focus:border-accent"
        />
      </label>
      {error && <p className="mt-2 text-danger">{error}</p>}
    </Dialog>
  );
}
