// What the backend's error messages mean, said the way the rest of the app talks. (Made when
// the module loads, like other tables of words: the language is settled by then.)
import { t } from "./i18n";

const SAYINGS: [RegExp, string][] = [
  [/does not exist/, t("找不到这个文件了（可能已经在别处删除或移动）")],
  [/can't be changed/, t("这个不能改")],
  [/already exists/, t("这里已经有同名的文件夹了")],
  [/empty or start with a dot/, t("名称不能为空，也不能以“.”开头")],
  [/wait for the sync|already running/, t("正在同步，等同步完成再试")],
  [/can't be renamed/, t("这个文件夹不能重命名")],
  // signing in
  [/token rejected/, t("令牌无效或已经过期。请在 Canvas 上重新生成一个。")],
  [/can't reach the site/, t("连不上这个网址。检查一下网址和网络连接。")],
  [/not a Canvas site/, t("这个网址不是 Canvas。请填学校 Canvas 的网址。")],
  [/not a web address/, t("网址不对。例如 bcourses.berkeley.edu")],
  [/https only/, t("只支持 https 网址：令牌不能明文传输。")],
  [/folder not empty/, t("这个文件夹里已经有别的东西了。请选一个空文件夹，或者以前用过的同步文件夹。")],
  [/another Canvas site/, t("这个文件夹在同步另一个 Canvas 网站的课程，请换一个文件夹。")],
  [/not a folder/, t("这不是一个文件夹。")],
  [/not a sync folder/, t("这里面没有同步过的内容。请选原来那个同步文件夹（里面有一个 .canvas 文件夹）。")],
  [/not signed in/, t("还没有登录 Canvas。请到设置里登录。")],
  [/not set up/, t("先在主窗口里登录 Canvas。")],
  [/could not list the courses/, t("没能从 Canvas 读到课程列表。检查一下网络连接，再试一次。")],
];

export function friendly(message: string): string {
  const said = SAYINGS.find(([re]) => re.test(message));
  return said ? said[1] : message;
}

const ED_SAYS: Record<string, string> = {
  "token rejected": t("Ed 不认这个令牌：可能填错了，或者已经被撤销。请在 Ed 上重新生成一个。"),
  "can't reach Ed": t("连不上 Ed。检查一下网络连接。"),
  "Ed changed": t("Ed 改了它的接口，暂时读不懂。已经同步的内容都还在。"),
};

/** What went wrong with Ed (EdError), said the way the app talks. */
export const edSaying = (reason: string) => ED_SAYS[reason] ?? reason;
