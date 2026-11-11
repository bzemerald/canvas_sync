// The window before the app: signing in, then choosing the courses. One box for both, so going
// from one to the other (and from step to step) glides from one height to the next.
import { useGlideHeight } from "../lib/flip";
import { t } from "../lib/i18n";
import { LanguagePicker } from "./LanguagePicker";
import { VersionLine } from "./VersionLine";

export function Welcome({ title, children }: { title: string; children: React.ReactNode }) {
  const [box, content] = useGlideHeight();
  return (
    <div data-tauri-drag-region className="flex h-screen items-center justify-center overflow-y-auto bg-bg p-8 text-fg">
      <div className="w-full max-w-lg">
        <h1 className="mb-5 text-xl font-semibold">{title}</h1>
        <div ref={box} className="overflow-hidden rounded-xl border border-line bg-panel">
          <div ref={content} className="p-5">{children}</div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 text-xs text-muted">
          <VersionLine />
          <span>{t("语言")}</span>
          <LanguagePicker />
        </div>
      </div>
    </div>
  );
}
