import { useEffect, useRef } from "react";

/** In-place name editor: Enter or clicking away saves, Escape cancels. */
export function RenameInput({ initial, onSubmit, onCancel, className = "" }: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = input.current?.value.trim() ?? "";
    if (save && name && name !== initial) onSubmit(name);
    else onCancel();
  };

  return (
    <input
      ref={input}
      defaultValue={initial}
      aria-label="新名称"
      onKeyDown={(e) => {
        e.stopPropagation(); // the list's own keys (arrows, Enter, Space) don't apply while typing
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`min-w-0 rounded border border-accent bg-panel px-1 outline-none ${className}`}
    />
  );
}
