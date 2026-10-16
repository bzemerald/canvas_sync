// Talks to the Python backend (`canvas serve`) that the shell starts for us.
import { invoke } from "@tauri-apps/api/core";

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

/** An announcement / assignment / page / syllabus, as listed. */
export interface ItemSummary {
  kind: DocKind;
  id: string;
  title: string;
  url: string | null; // on Canvas, relative to the site
  date: string | null; // posted / due / updated
  author?: string | null;
  unread?: boolean;
  preview?: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  points?: number | null;
  submission_types?: string[];
  front_page?: boolean;
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
  file?: string; // the local copy
  doc?: { kind: DocKind; id: string }; // shown in the app
  external?: string; // a web link
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
  new_files: { file_id: number; path: string; name: string; date: string | null }[];
  counts: { modules: number; announcements: number; assignments: number; pages: number; files: number; syllabus: boolean };
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
}

export interface FileStatus {
  path: string | null;
  file_id: number;
  course_id: number;
  states: string[];
}

export interface SmartFolder {
  name: string;
  query: string;
  courses: number[];
  kinds: Kind[];
  content: boolean; // also match text inside files and pages, not just names
}

/** A sidebar entry: a pinned folder, or a smart folder (a saved search). */
export type PinnedItem =
  | { type: "course"; id: number; exists: boolean }
  | { type: "folder"; path: string; course_id: number | null; exists: boolean }
  | ({ type: "smart" } & SmartFolder);

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
  opts: { limit?: number; courses?: number[]; kinds?: Kind[]; namesOnly?: boolean } = {},
): Promise<Hit[]> {
  const params = new URLSearchParams({ q, limit: String(opts.limit ?? 50) });
  if (opts.namesOnly) params.set("names_only", "true");
  for (const c of opts.courses ?? []) params.append("course", String(c));
  for (const k of opts.kinds ?? []) params.append("kind", k);
  return api(`/search?${params}`);
}

export const courses = () => api<Course[]>("/courses");
export const overview = (course: number) => api<Overview>(`/courses/${course}/overview`);
export const modules = (course: number) => api<Module[]>(`/courses/${course}/modules`);
export const items = (course: number, kind: DocKind) => api<ItemSummary[]>(`/courses/${course}/items?kind=${kind}`);
export const item = (course: number, kind: DocKind, id: string) =>
  api<Item>(`/courses/${course}/items/${kind}/${encodeURIComponent(id)}`);

/** An image in a page (needs the Canvas login, or is on another site), as an object URL. */
export async function media(url: string): Promise<string | null> {
  const { port, token } = await getBackend();
  const res = await fetch(`http://127.0.0.1:${port}/api/media?${new URLSearchParams({ url })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}
export const health = () => api<{ root: string; canvas: string }>("/health");
export const status = () => api<FileStatus[]>("/status");
export const tree = (path: string) => api<Entry[]>(`/tree?${new URLSearchParams({ path })}`);

export const syncState = () => api<SyncState>("/sync");
export const startSync = (scope: Scope = {}) => api<SyncState>("/sync", { method: "POST", body: JSON.stringify(scope) });

export const restorePreview = (scope: Scope) =>
  api<{ files: FileStatus[] }>("/restore", { method: "POST", body: JSON.stringify({ ...scope, dry_run: true }) });
export const restore = (scope: Scope) =>
  api<{ restored: string[] }>("/restore", { method: "POST", body: JSON.stringify(scope) });

const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

export const pinned = () => api<PinnedItem[]>("/pinned");
export const pinFolder = (path: string) => post<PinnedItem[]>("/pinned", { path });
export const unpinFolder = (path: string) => post<PinnedItem[]>("/pinned/remove", { path });
export const pinCourse = (course: number) => post<PinnedItem[]>("/pinned", { course });
export const unpinCourse = (course: number) => post<PinnedItem[]>("/pinned/remove", { course });
export const movePinned = (index: number, to: number) => post<PinnedItem[]>("/pinned/move", { index, to });
export const saveSmartFolder = (folder: SmartFolder, replaces?: string) =>
  post<PinnedItem[]>("/smart-folders", { ...folder, replaces });
export const deleteSmartFolder = (name: string) =>
  api<PinnedItem[]>(`/smart-folders/${encodeURIComponent(name)}`, { method: "DELETE" });

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

/** A link to anywhere on the web, in the browser. */
export function openExternal(url: string) {
  return api("/open", { method: "POST", body: JSON.stringify({ external: url }) });
}

let canvasBase: Promise<string> | null = null;
/** The Canvas site's address, e.g. https://bcourses.berkeley.edu */
export const canvasSite = () => (canvasBase ??= health().then((h) => h.canvas));

/** Open a result: the local file if we have one, else its Canvas page in the browser. */
export function openHit(hit: Hit, reveal = false) {
  return hit.path ? openPath(hit.path, { reveal }) : openUrl(hit.url ?? "/");
}

export function openCanvas(hit: Hit) {
  return openUrl(hit.url ?? "/");
}
