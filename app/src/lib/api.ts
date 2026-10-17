// Talks to the Python backend (`canvas serve`) that the shell starts for us.
import { invoke } from "@tauri-apps/api/core";
import type { LangPref } from "./i18n";
import type { Placed, Shown } from "./things";

export type Kind = "file" | "page" | "assignment" | "announcement" | "syllabus";

export interface Hit {
  kind: Kind;
  course_id: number;
  course: string;
  title: string;
  path: string | null;
  url: string | null;
  date: string | null;
  snippet: { text: string; match: boolean }[];
  match: "name" | "content"; // name: title or folder matched; content: only the text inside
  doc_id: string | null; // pages, assignments, announcements, syllabus: which one
}

export type DocKind = "announcement" | "assignment" | "page" | "syllabus";

/** Where you are with an assignment. null: Canvas can't tell (handed in on Gradescope, on paper…). */
export type SubmissionStatus = "graded" | "submitted" | "missing" | "excused" | "unsubmitted" | null;

/** An announcement / assignment / page / syllabus, as listed. */
export interface ItemSummary {
  kind: DocKind;
  id: string;
  title: string;
  url: string | null; // on Canvas, relative to the site
  date: string | null; // posted / due / updated
  new: boolean; // arrived since you last looked, and you haven't opened (or read / handed in on Canvas)
  author?: string | null;
  preview?: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  points?: number | null;
  submission_types?: string[];
  front_page?: boolean;
  // assignments: your submission, and its grade once posted
  grading_type?: string | null; // points / percent / letter_grade / gpa_scale / pass_fail / not_graded
  status?: SubmissionStatus;
  late?: boolean;
  submitted_at?: string | null;
  graded_at?: string | null;
  score?: number | null;
  grade?: string | null;
  tool?: { assignment_id: number; name: string | null }; // handed in on an external tool (Gradescope…)
}

/** An external tool in the course's menu (Gradescope, Ed, Zoom…). */
export interface Tool {
  id: number;
  label: string | null;
  url: string | null; // its page on Canvas
}

/** Which tool to open, and from where. */
export type LaunchTarget =
  | { tool_id: number }
  | { module_item_id: number }
  | { assignment_id: number }
  | { url: string }; // a tool's launch URL

/** Your grade in a course as Canvas computes it. current: graded work only; final: the rest counts as 0. */
export interface Total {
  current_score: number;
  current_grade: string | null;
  final_score: number | null;
  final_grade: string | null;
}

export interface Grades {
  total: Total | null; // null: the course doesn't show one
  assignments: ItemSummary[];
}

export interface NewCounts {
  announcements: number;
  assignments: number;
  pages: number;
  files: number;
}

/** One in full: its HTML, and local copies of the Canvas files it refers to. */
export interface Item extends ItemSummary {
  html: string;
  files: Record<string, { path: string; name: string }>;
  attachments: { id: number; name: string; path: string | null }[];
}

/** One entry in a module, and where clicking it leads. */
export interface ModuleItem {
  id: number | null;
  type: "File" | "Page" | "Assignment" | "Quiz" | "Discussion" | "ExternalUrl" | "ExternalTool" | "SubHeader" | string;
  title: string;
  indent: number;
  done: boolean; // a completion requirement you've met
  new: boolean;
  file?: string; // the local copy
  doc?: { kind: DocKind; id: string }; // shown in the app
  external?: string; // a web link
  tool?: { module_item_id: number; name: string | null }; // an external tool
  url?: string; // on Canvas
  deleted?: boolean; // a file you deleted
  due_at?: string | null;
}

export interface Module {
  id: number;
  name: string;
  position: number;
  unlock_at: string | null;
  state: string | null; // Canvas's: locked / unlocked / started / completed
  folder: string | null; // its folder in 文件, if there is one
  current: boolean; // has the newest upload or the next deadline
  items: ModuleItem[];
}

export interface Overview {
  upcoming: ItemSummary[];
  announcements: ItemSummary[];
  new_files: { file_id: number; path: string; name: string; date: string | null; new: boolean; updated: boolean }[];
  grades: { total: Total | null; recent: ItemSummary[] };
  tools: Tool[];
  current_modules: Module[]; // this week's (newest upload, next deadline)
  new: NewCounts;
  counts: {
    modules: number; announcements: number; assignments: number; pages: number; files: number; syllabus: boolean; grades: boolean;
  };
}

export interface Course {
  id: number;
  name: string;
  code: string;
  display_code: string;
  term: string | null;
  dir: string; // where its files are (an implementation detail the UI mostly keeps to itself)
  label: string; // what to call it: the name you gave it, else its course code
  renamed: boolean;
  default_name: string; // renaming to this gives it its original name back
  term_label: string | null; // the term, as you named it
  new: number; // things in it you haven't opened yet
  icon: { icon?: string; color?: string; emoji?: string } | null; // chosen; null: the app picks one
  hidden: boolean; // you hid it: not in the sidebar's terms, search or what's new
  excluded: boolean; // not synced
}

export interface Entry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number | null;
  mtime: number | null;
  file_id: number | null;
  course_id: number | null;
  url: string | null;
  link: string | null;
  states: string[];
  deleted: boolean;
  changes: number;
  skipped: boolean; // dirs: deleted or unsynced by you; Canvas's new files don't come here
  new: "new" | "updated" | null; // files: arrived (or came in a new version) since you last opened it
  new_inside: number; // dirs: new files below
}

export interface FileStatus {
  path: string | null;
  file_id: number;
  course_id: number;
  states: string[];
}

/** A course's places: its tabs, its overview's cards, its 工具与链接 (links); each with all it
 * holds, in order. `own`: arranged for the course (else it follows the default). */
export type Place = "tabs" | "overview" | "links";
export interface CourseLayout {
  tabs: Placed[];
  overview: Placed[];
  links: Placed[];
  own: Record<Place, boolean>;
}

export const courseLayout = (course: number) => api<CourseLayout>(`/courses/${course}/layout`);
const put = <T,>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
/** One of a course's places as it should be (its own things it leaves out come back). */
export const arrangeCourse = (course: number, place: Place, entries: Shown[]) =>
  put<CourseLayout>(`/courses/${course}/layout/${place}`, { entries });
/** Back to the default; what was added stays, after the rest. */
export const resetCourseLayout = (course: number, place: Place) => post<CourseLayout>(`/courses/${course}/layout/${place}/reset`, {});
/** Its tabs, or its overview, as every course's default (what it added stays its own). */
export const makeDefaultLayout = (course: number, place: Place) => post<CourseLayout>(`/courses/${course}/layout/${place}/default`, {});
export const note = (course: number, id: string) => api<{ text: string }>(`/courses/${course}/notes/${id}`);
export const saveNote = (course: number, id: string, text: string) =>
  api<{ text: string }>(`/courses/${course}/notes/${id}`, { method: "PUT", body: JSON.stringify({ text }) });

/** A term, course, folder or file: what a sync or restore applies to. */
export interface Scope {
  paths?: string[];
  file_ids?: number[];
}

export interface SyncState {
  phase: "idle" | "checking" | "downloading" | "indexing" | "done" | "failed";
  scope: string[];
  running: boolean;
  total: number;
  done: number;
  current: string;
  changes: Record<string, number>;
  errors: string[];
  warnings: string[];
  finished_at: string | null;
  last_synced?: string | null; // when a sync last finished, this run of the app or before
}

/** The app's preferences (this computer's), and which courses the sync folder syncs. */
export interface Prefs {
  language: LangPref;
  auto_sync: number; // minutes between automatic syncs; 0: off
  sync_on_launch: boolean;
  select?: "active" | "favorites"; // (once an account is set up)
}

export interface AccountInfo {
  set_up: boolean; // false: show the sign-in
  signed_in: boolean; // a token is saved
  base_url: string | null;
  root: string | null; // the sync folder
  user: string | null; // your name on Canvas
}

interface Backend {
  port: number;
  token: string;
}

let backend: Promise<Backend> | null = null;

function getBackend(): Promise<Backend> {
  if (!backend) {
    backend = invoke<Backend>("backend").catch((e) => {
      backend = null; // let the next call try again
      throw new Error(String(e));
    });
  }
  return backend;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { port, token } = await getBackend();
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function search(
  q: string,
  opts: { limit?: number; courses?: number[]; kinds?: Kind[]; namesOnly?: boolean; under?: string } = {},
): Promise<Hit[]> {
  const params = new URLSearchParams({ q, limit: String(opts.limit ?? 50) });
  if (opts.namesOnly) params.set("names_only", "true");
  if (opts.under) params.set("under", opts.under); // only files in this folder
  for (const c of opts.courses ?? []) params.append("course", String(c));
  for (const k of opts.kinds ?? []) params.append("kind", k);
  return api(`/search?${params}`);
}

/** Something search can go to by name (src/canvas_sync/catalog.py): a thing, what Canvas or the
 * sync folder calls it (`name`; null: what the app names), a name you gave it (`title`), the
 * other names it answers to, the course it's in; when it's from, and for an assignment when it's
 * due and where you are with it. `canvas_url`: where it is on Canvas. */
export type CatalogEntry = Shown & {
  name: string | null;
  title: string;
  aliases: string[];
  in_course: number | null;
  term?: string; // a course's
  date?: string | null;
  due?: string | null;
  status?: SubmissionStatus;
  text?: string; // a note's first line
  canvas_url?: string;
};
/** What you open: how often and when last, by thingKey; and what you'd typed in search for what. */
export interface Usage {
  opened: Record<string, { count: number; last: string }>;
  picks: { query: string; key: string; count: number; last: string }[];
}
export const catalog = () => api<{ things: CatalogEntry[] } & Usage>("/catalog");
/** It was opened (having typed `query` in search): what you open most, and lately, comes first. */
export const noteOpened = (key: string, query = "") => void post("/opened", { key, query }).catch(() => {});

export const courses = () => api<Course[]>("/courses");
export const overview = (course: number) => api<Overview>(`/courses/${course}/overview`);
export const modules = (course: number) => api<Module[]>(`/courses/${course}/modules`);
export const items = (course: number, kind: DocKind) => api<ItemSummary[]>(`/courses/${course}/items?kind=${kind}`);
/** One in full. Opening it marks it seen. */
export const item = (course: number, kind: DocKind, id: string) =>
  api<Item>(`/courses/${course}/items/${kind}/${encodeURIComponent(id)}`);
export const grades = (course: number) => api<Grades>(`/courses/${course}/grades`);
/** Mark everything new in a course as seen (or only some kinds of things). */
export const markSeen = (course: number, kinds?: ("announcement" | "assignment" | "page" | "file")[]) =>
  api<NewCounts>(`/courses/${course}/seen`, { method: "POST", body: JSON.stringify({ kinds: kinds ?? null }) });

/** An image in a page (needs the Canvas login, or is on another site), as an object URL. */
export async function media(url: string): Promise<string | null> {
  const { port, token } = await getBackend();
  const res = await fetch(`http://127.0.0.1:${port}/api/media?${new URLSearchParams({ url })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}
export const health = () => api<{ root: string | null; canvas: string | null; set_up: boolean; version: string }>("/health");
export const status = () => api<FileStatus[]>("/status");
export const tree = (path: string) => api<Entry[]>(`/tree?${new URLSearchParams({ path })}`);

export const syncState = () => api<SyncState>("/sync");
export const startSync = (scope: Scope = {}) => api<SyncState>("/sync", { method: "POST", body: JSON.stringify(scope) });

export const restorePreview = (scope: Scope) =>
  api<{ files: FileStatus[] }>("/restore", { method: "POST", body: JSON.stringify({ ...scope, dry_run: true }) });
export const restore = (scope: Scope) =>
  api<{ restored: string[] }>("/restore", { method: "POST", body: JSON.stringify(scope) });

function post<T>(path: string, body: unknown) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

/** 置顶: what's pinned, in order (smart folders are searches pinned). */
export const pinned = () => api<Placed[]>("/pinned");
export const arrangePinned = (entries: Shown[]) => put<Placed[]>("/pinned", { entries });

/** How the sidebar is arranged: terms (by Canvas's name for them) and courses, in order. */
export interface SidebarOrder {
  terms: string[];
  courses: number[];
}
export const sidebarOrder = () => api<SidebarOrder>("/sidebar");
/** A course's icon: {icon, color}, {emoji}, {icon: "none"}; null: the app's pick. */
export const setCourseIcon = (course: number, icon: { icon?: string; color?: string; emoji?: string } | null) =>
  post<{ icon: Course["icon"] }>(`/courses/${course}/icon`, icon ?? {});
/** The same for several courses (a whole term). */
export const hideCourses = (courses: number[], hidden: boolean, syncing?: boolean) =>
  post<{ hidden: number[]; excluded: number[] }>("/courses/hide", { courses, hidden, syncing: syncing ?? null });
/** Hide a course (syncing: false also stops syncing it), or show it again (syncing: true resumes). */
export const hideCourse = (course: number, hidden: boolean, syncing?: boolean) =>
  post<{ hidden: boolean; excluded: boolean }>(`/courses/${course}/hide`, { hidden, syncing: syncing ?? null });
export const arrangeSidebar = (order: Partial<SidebarOrder>) => post<SidebarOrder>("/sidebar", order);

export interface DeletePreview {
  canvas_files: number;
  own_files: number;
  folders: string[];
  canvas_folders: string[];
}

export const deletePreview = (paths: string[]) => post<DeletePreview>("/delete", { paths, dry_run: true });
/** To the Trash; files from Canvas aren't downloaded again (and can be restored). */
export const deletePaths = (paths: string[], stopSyncingFolders: boolean) =>
  post<{ deleted: string[] }>("/delete", { paths, stop_syncing_folders: stopSyncingFolders });
/** Keep the files, as your own; stop syncing them (and new files in the folders). */
export const untrack = (paths: string[]) => post<{ files: number }>("/untrack", { paths });
export const track = (paths: string[]) => post<{ files: number }>("/track", { paths });

/** Rename a folder; syncing keeps putting Canvas's files in it. Returns the new path. */
export const rename = (path: string, name: string) => post<{ path: string }>("/rename", { path, name });

/** A JPEG preview as an object URL, or null if the file has none. */
export async function thumb(path: string, size: number): Promise<string | null> {
  const { port, token } = await getBackend();
  const params = new URLSearchParams({ path, size: String(size) });
  const res = await fetch(`http://127.0.0.1:${port}/api/thumb?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}

export function openPath(path: string, how: { reveal?: boolean; preview?: boolean } = {}) {
  return api("/open", { method: "POST", body: JSON.stringify({ path, ...how }) });
}

export function openUrl(url: string) {
  return api("/open", { method: "POST", body: JSON.stringify({ url }) });
}

/** Open an external tool in the browser, signed in where Canvas allows (else its page on Canvas). */
export const launch = (course: number, target: LaunchTarget) =>
  post<{ opened: string; signed_in: boolean }>("/launch", { course_id: course, ...target });

/** A link to anywhere on the web, in the browser. */
export function openExternal(url: string) {
  return api("/open", { method: "POST", body: JSON.stringify({ external: url }) });
}

let canvasBase: Promise<string | null> | null = null;
/** The Canvas site's address, e.g. https://bcourses.berkeley.edu */
export const canvasSite = () => (canvasBase ??= health().then((h) => h.canvas));

export const prefs = () => api<Prefs>("/prefs");
export const setPrefs = (changes: Partial<Prefs>) => post<Prefs>("/prefs", changes);
export const account = () => api<AccountInfo>("/account");
/** Whether the saved token still works (asks Canvas). */
export const checkAccount = () => api<{ ok: boolean; user?: string; error?: string }>("/account/check");
/** Sign in (or switch account / school): checks the token, then starts the first sync. */
export const setUp = (url: string, token: string, root?: string) => post<AccountInfo>("/account/setup", { url, token, root });
export const replaceToken = (token: string) => post<AccountInfo>("/account/token", { token });
export const signOut = () => post<AccountInfo>("/account/signout", {});
/** The sync folder's config.toml, in a text editor. */
export const openConfig = () => post<{ opened: string }>("/open/config", {});

/** Open a result: the local file if we have one, else its Canvas page in the browser. */
export function openHit(hit: Hit, reveal = false) {
  return hit.path ? openPath(hit.path, { reveal }) : openUrl(hit.url ?? "/");
}

export function openCanvas(hit: Hit) {
  return openUrl(hit.url ?? "/");
}
