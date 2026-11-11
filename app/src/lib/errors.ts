// What the backend's error messages mean, said the way the rest of the app talks. (Made when
// the module loads, like other tables of words: the language is settled by then.)
import { t } from "./i18n";

const SAYINGS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  // (First: they quote paths and the system's error, which may say anything.)
  [/^partly moved\n(.*)\n(.*)$/, (m) => t("没能移动同步文件夹，有些文件也没能移回去。它们现在在 {dst}，把它们移回 {src} 后再试一次。", { src: m[1], dst: m[2] })],
  [/could not move/, t("没能移动同步文件夹，文件还在原来的位置。可能有文件正被其他应用使用，关掉后再试一次。")],
  [/move into itself/, t("不能移到现在的同步文件夹里面。请选别的文件夹。")],
  [/move target not empty/, t("这个文件夹不是空的。请选一个空文件夹。")],
  [/not enough room/, t("那里的磁盘空间不够放下同步文件夹。")],
  [/links not supported there/, t("那个磁盘（比如 exFAT 或 FAT 格式的 U 盘、移动硬盘）放不了同步文件夹里的链接。请选别的位置。")],
  [/the app is busy/, t("应用还在忙别的事，过一会儿再试。")],
  [/moving the sync folder/, t("正在移动同步文件夹，等移动完成再试")],
  [/does not exist/, t("找不到这个文件了（可能已经在别处删除或移动）")],
  [/can't be changed/, t("这个不能改")],
  [/already exists/, t("这里已经有同名的文件夹了")],
  [/empty or start with a dot/, t("名称不能为空，也不能以“.”开头")],
  [/wait for the sync|already running/, t("正在同步，等同步完成再试")],
  [/add it by hand/, t("读不懂这个应用的设置文件，所以没有改动它。可以用下面的“手动添加到其他应用”。")],
  [/can't be renamed/, t("这个文件夹不能重命名")],
  // signing in
  [/token rejected/, t("令牌无效或已经过期。请在 Canvas 上重新生成一个。")],
  [/sign-in rejected/, t("Canvas 没有接受这次登录。请再登录一次。")],
  [/can't reach the site/, t("连不上这个网址。检查一下网址和网络连接。")],
  [/not a Canvas site/, t("这个网址不是 Canvas。请填学校 Canvas 的网址。")],
  [/not a web address/, t("网址不对。例如 bcourses.berkeley.edu")],
  [/https only/, t("只支持 https 网址：令牌不能明文传输。")],
  [/folder not empty/, t("这个文件夹里已经有别的东西了。请选一个空文件夹，或者以前用过的同步文件夹。")],
  [/another Canvas site/, t("这个文件夹在同步另一个 Canvas 网站的课程，请换一个文件夹。")],
  [/not a folder/, t("这不是一个文件夹。")],
  [/not a sync folder/, t("无法识别这个文件夹为同步文件夹。请选原来那个同步文件夹，或者从头开始。")],
  [/not signed in/, t("还没有登录 Canvas。请到设置里登录。")],
  [/not set up/, t("先在主窗口里登录 Canvas。")],
  [/could not list the courses/, t("没能从 Canvas 读到课程列表。检查一下网络连接，再试一次。")],
];

export function friendly(message: string): string {
  for (const [re, saying] of SAYINGS) {
    const m = message.match(re);
    if (m) return typeof saying === "string" ? saying : saying(m);
  }
  return message;
}

// A sync: why it failed as a whole, and why a file didn't sync. (The backend's words stay in a
// tooltip, for when someone has to look into it.)
const SYNC_SAYINGS: [RegExp, string][] = [
  [/ConnectError|ConnectTimeout|ReadTimeout|TimeoutException|NetworkError|RemoteProtocolError|nodename|Network is unreachable/,
    t("连不上 Canvas。检查一下网络连接。")],
  [/HTTP (5\d\d|429)\b|rate limit/i, t("Canvas 暂时出错了，过一会儿再试。")],
  [/No space left|Errno 28/, t("磁盘空间不够了。")],
  [/Permission denied|Errno 13|Operation not permitted/, t("没有权限写入同步文件夹。")],
  [/database is locked/, t("应用还在忙别的事，过一会儿再试。")],
  [/ConfigError/, t("配置文件（config.toml）有错，没能读懂。可以在设置里打开它看看。")],
  [/sync folder missing/, t("找不到同步文件夹了。")],
];

export function syncSaying(message: string): string {
  for (const [re, saying] of SYNC_SAYINGS) if (re.test(message)) return saying;
  const known = friendly(message);
  return known !== message ? known : t("同步出错了。");
}

const FILE_SAYINGS: [RegExp, string][] = [
  [/HTTP 403/, t("老师还没开放，或者已经锁定")],
  [/HTTP 404/, t("Canvas 上已经没有了")],
  [/HTTP 401/, t("登录已过期")],
  [/download failed|HTTP (0|5\d\d)\b/, t("没能下载，下次同步再试")],
  [/not a symlink/, t("本地有同名的文件挡住了")],
  [/Permission denied|Errno 13|used by another process/, t("文件正被别的应用占用")],
  [/No space left|Errno 28/, t("磁盘空间不够")],
];

export function fileSaying(message: string): string {
  for (const [re, saying] of FILE_SAYINGS) if (re.test(message)) return saying;
  return t("没能同步");
}

const ED_SAYS: Record<string, string> = {
  "token rejected": t("Ed 不认这个令牌：可能填错了，或者已经被撤销。请在 Ed 上重新生成一个。"),
  "can't reach Ed": t("连不上 Ed。检查一下网络连接。"),
  "Ed changed": t("Ed 改了它的接口，Canvas Sync 暂时读不懂。请等待应用更新。"),
};

/** What went wrong with Ed (EdError), said the way the app talks. */
export const edSaying = (reason: string) => ED_SAYS[reason] ?? reason;
