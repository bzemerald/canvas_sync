import { useEffect } from "react";

/** A centered modal. Escape or clicking outside cancels. */
export function Dialog({ title, onClose, children, footer, width = "max-w-lg" }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode; // (a form inside may bring its own buttons)
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6"
      onMouseDown={onClose}
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
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-full w-full ${width} flex-col rounded-xl border border-line bg-panel shadow-2xl`}
      >
        <h2 className="px-5 pt-4 pb-2 text-base font-semibold">{title}</h2>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 text-sm">{children}</div>
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
