// What the backend's error messages mean, said the way the rest of the app talks. (Made when
// the module loads, like other tables of words: the language is settled by then.)
import { t } from "./i18n";

const SAYINGS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  // (First: they quote paths and the system's error, which may say anything.)
  [/^partly moved\n(.*)\n(.*)$/, (m) => t("Couldn't move the sync folder, and some files couldn't be moved back. They're in {dst} now: move them back to {src}, then try again.", { src: m[1], dst: m[2] })],
  [/could not move/, t("Couldn't move the sync folder, so your files are still where they were. Another app may be using one of them: close it and try again.")],
  [/move into itself/, t("It can't move inside the current sync folder. Choose another folder.")],
  [/move target not empty/, t("That folder isn't empty. Choose an empty folder.")],
  [/not enough room/, t("There isn't enough disk space there for the sync folder.")],
  [/links not supported there/, t("That disk (an exFAT or FAT drive, say) can't hold the links in the sync folder. Choose another place.")],
  [/the app is busy/, t("The app is still busy with something else. Try again in a moment.")],
  [/moving the sync folder/, t("The sync folder is moving. Try again when it's done")],
  [/does not exist/, t("Can't find the file (it may have been deleted or moved elsewhere)")],
  [/can't be changed/, t("This can't be changed")],
  [/already exists/, t("The name is already taken by another folder")],
  [/empty or start with a dot/, t("Names can't be empty or start with “.”")],
  [/wait for the sync|already running/, t("Syncing; try again once it's done")],
  [/add it by hand/, t("Couldn't read this app's settings file, so nothing was changed. You can use “Add to another app by hand” below.")],
  [/can't be renamed/, t("This folder can't be renamed")],
  // signing in
  [/token rejected/, t("That token isn't valid, or it expired. Make a new one in Canvas.")],
  [/sign-in rejected/, t("Canvas didn't accept this sign-in. Please sign in again.")],
  [/can't reach the site/, t("Couldn't reach that address. Make sure it's spelled correctly and check your internet connection.")],
  [/not a Canvas site/, t("That address isn't Canvas. Enter your school's Canvas address.")],
  [/not a web address/, t("That isn't a web address. For example: bcourses.berkeley.edu")],
  [/https only/, t("Only https addresses work: the token mustn't travel unencrypted.")],
  [/folder not empty/, t("That folder already has other things in it. Choose an empty folder, or one you've synced into before.")],
  [/another Canvas site/, t("That folder holds another Canvas site's courses; choose a different one.")],
  [/not a folder/, t("That isn't a folder.")],
  [/not a sync folder/, t("This folder isn't recognized as a synced folder. Please choose the old sync folder or start from scratch.")],
  [/not signed in/, t("You're not signed in to Canvas. Sign in from Settings.")],
  [/not set up/, t("Sign in to Canvas in the main window first.")],
  [/could not list the courses/, t("Couldn't get the list of courses from Canvas. Check the network connection and try again.")],
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
    t("Can't reach Canvas. Check your internet connection.")],
  [/HTTP (5\d\d|429)\b|rate limit/i, t("Canvas had a problem. Try again in a while.")],
  [/No space left|Errno 28/, t("The disk is full.")],
  [/Permission denied|Errno 13|Operation not permitted/, t("Not allowed to write to the sync folder.")],
  [/database is locked/, t("The app is still busy with something else. Try again in a moment.")],
  [/ConfigError/, t("The config file (config.toml) has an error and couldn't be read. You can open it from Settings.")],
  [/sync folder missing/, t("The sync folder can't be found.")],
];

export function syncSaying(message: string): string {
  for (const [re, saying] of SYNC_SAYINGS) if (re.test(message)) return saying;
  const known = friendly(message);
  return known !== message ? known : t("Something went wrong while syncing.");
}

const FILE_SAYINGS: [RegExp, string][] = [
  [/HTTP 403/, t("Not published yet, or locked")],
  [/HTTP 404/, t("No longer on Canvas")],
  [/HTTP 401/, t("Signed out")],
  [/download failed|HTTP (0|5\d\d)\b/, t("Couldn't download; the next sync tries again")],
  [/not a symlink/, t("A file with the same name is in the way")],
  [/Permission denied|Errno 13|used by another process/, t("In use by another app")],
  [/No space left|Errno 28/, t("The disk is full")],
];

export function fileSaying(message: string): string {
  for (const [re, saying] of FILE_SAYINGS) if (re.test(message)) return saying;
  return t("Couldn't sync");
}

const ED_SAYS: Record<string, string> = {
  "token rejected": t("Ed doesn't accept this token: it may be mistyped, or revoked. Create a new one on Ed."),
  "can't reach Ed": t("Can't reach Ed. Check your internet connection."),
  "Ed changed": t("Ed changed its interface, and Canvas Sync doesn't understand it for now. Please wait for an app update."),
};

/** What went wrong with Ed (EdError), said the way the app talks. */
export const edSaying = (reason: string) => ED_SAYS[reason] ?? reason;
