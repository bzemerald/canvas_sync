// The window's buttons where the app draws its own title bar (lib/window.ts): over the top right
// of every page, in the toolbar's row. They look as Windows draws them. The app's icon and name
// are at the top left.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import icon from "../../src-tauri/icons/32x32.png";
import { t } from "../lib/i18n";

export function WindowControls() {
  const w = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const check = () => void w.isMaximized().then(setMaximized, () => {});
    check();
    const off = w.onResized(check);
    return () => void off.then((f) => f());
  }, [w]);
  const button = "flex w-[46px] items-center justify-center text-fg-soft";
  return (
    // (Above a dialog's backdrop, so the window can still be closed; below menus.)
    <>
    <div className="pointer-events-none fixed top-0 left-4 z-[45] flex h-13 items-center gap-2 text-sm font-medium select-none">
      <img src={icon} alt="" className="size-[18px]" />
      Canvas Sync
    </div>
    <div className="fixed top-0 right-0 z-[45] flex h-13">
      <button title={t("最小化")} aria-label={t("最小化")} onClick={() => void w.minimize()} className={`${button} hover:bg-chip`}>
        <Minus className="size-4" aria-hidden />
      </button>
      <button title={maximized ? t("还原") : t("最大化")} aria-label={maximized ? t("还原") : t("最大化")} onClick={() => void w.toggleMaximize()} className={`${button} hover:bg-chip`}>
        {maximized ? <Copy className="size-3.5 -scale-x-100" aria-hidden /> : <Square className="size-3.5" aria-hidden />}
      </button>
      <button title={t("关闭")} aria-label={t("关闭")} onClick={() => void w.close()} className={`${button} hover:bg-[#e81123] hover:text-white`}>
        <X className="size-4" aria-hidden />
      </button>
    </div>
    </>
  );
}
