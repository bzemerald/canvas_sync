import { t } from "../lib/i18n";
import { isMac, shortcut, trashName } from "../lib/keys";
import { keysLabel, useLauncherKeys } from "../lib/launcherKeys";
import { Button, Dialog } from "./Dialog";

/** Every keyboard shortcut, by where it works (⌘/ shows it). */
export function KeysDialog({ onClose }: { onClose: () => void }) {
  const launcher = useLauncherKeys();
  const groups: [string, [string, string][]][] = [
    [t("任何地方"), [
      [t("搜索窗口"), keysLabel(launcher)],
      [t("在这一页搜索"), shortcut.search],
      [t("同步所有课程"), shortcut.sync],
      [t("后退 / 前进"), `${shortcut.back} / ${shortcut.forward}`],
      [t("上一门 / 下一门课程"), `${shortcut.prevCourse} / ${shortcut.nextCourse}`],
      [t("设置"), shortcut.settings],
      [t("键盘快捷键"), shortcut.shortcuts],
    ]],
    [t("课程里"), [
      [t("第 1 到 9 个标签（9：最后一个）"), shortcut.tab],
      [t("下一个标签"), shortcut.nextTab],
      [t("上一个标签"), shortcut.prevTab],
      [t("公告、作业、Ed、页面：上一条 / 下一条"), `${shortcut.up} / ${shortcut.down}`],
      [t("向下 / 向上翻页"), isMac ? "Space / ⇧Space" : "Space / Shift+Space"],
    ]],
    [t("文件"), [
      [t("选择"), "↑ ↓ ← →"],
      [t("打开"), shortcut.open],
      ...(isMac ? [[t("快速预览"), shortcut.preview] as [string, string]] : []),
      [t("重命名"), shortcut.rename],
      [t("上一级文件夹"), shortcut.parent],
      [t("移到{trash}", { trash: trashName }), shortcut.delete],
      ...(shortcut.toggleChanges ? [[t("显示改动"), shortcut.toggleChanges] as [string, string]] : []),
    ]],
    [t("搜索框"), [
      [t("选择结果"), "↑ ↓"],
      [t("打开"), "↩"],
      [t("在文件夹中显示"), isMac ? "⌘↩" : "Ctrl+Enter"],
      [t("在 Canvas 中打开"), isMac ? "⌘⇧↩" : "Ctrl+Shift+Enter"],
      [t("补全课程名"), "⇥"],
      [t("清空并离开搜索框"), "Esc"],
    ]],
  ];
  return (
    <Dialog title={t("键盘快捷键")} onClose={onClose} width="max-w-xl" footer={<Button primary onClick={onClose}>{t("好")}</Button>}>
      <div className="space-y-4 pb-2">
        {groups.map(([name, rows]) => (
          <section key={name}>
            <h3 className="mb-1 text-xs font-medium text-muted">{name}</h3>
            <dl className="divide-y divide-line">
              {rows.map(([what, keys]) => (
                <div key={what} className="flex items-center justify-between gap-4 py-1.5">
                  <dt>{what}</dt>
                  <dd className="shrink-0 font-mono text-xs text-fg-soft">{keys}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
