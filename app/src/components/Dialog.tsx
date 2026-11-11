import { X } from "lucide-react";
import { useEffect } from "react";
import { useGlideHeight } from "../lib/flip";
import { t } from "../lib/i18n";

/** A centered modal. Escape or its × cancels; clicking outside doesn't (what's half filled in stays). */
export function Dialog({ title, onClose, children, footer, width = "max-w-lg" }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode; // (a form inside may bring its own buttons)
  width?: string;
}) {
  const [box, content] = useGlideHeight(); // (going to the next step, say)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6"
      onMouseDown={(e) => e.stopPropagation()} // (not to what's behind it, as with onContextMenu)
      onContextMenu={(e) => {
        // Not the menu of what's behind it (React passes events up to where the dialog was opened).
        e.stopPropagation();
        const el = e.target as HTMLElement;
        if (!el.closest("input, textarea, [contenteditable]") && !window.getSelection()?.toString()) e.preventDefault();
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        className={`flex max-h-full w-full ${width} flex-col rounded-xl border border-line bg-panel shadow-2xl`}
      >
        <div className="flex items-start gap-2 px-5 pt-4 pb-2">
          <h2 className="min-w-0 flex-1 text-base font-semibold">{title}</h2>
          <button onClick={onClose} title={t("关闭")} aria-label={t("关闭")}
            className="-mr-2 shrink-0 rounded p-1 text-muted hover:bg-chip hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div ref={box} className="min-h-0 shrink overflow-y-hidden">
          <div ref={content} className="px-5 pb-2 text-sm">{children}</div>
        </div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Button({ primary, danger, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; danger?: boolean }) {
  const look = danger
    ? "bg-danger text-on-accent hover:opacity-90"
    : primary
      ? "bg-accent text-on-accent hover:opacity-90"
      : "border border-line text-fg hover:bg-chip";
  return <button {...props} className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${look} ${props.className ?? ""}`} />;
}
