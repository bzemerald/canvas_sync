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
}

export interface Course {
  id: number;
  name: string;
  code: string;
  display_code: string;
  term: string | null;
  dir: string;
  folder_name: string | null; // set if you renamed the course's folder
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
export const movePinned = (index: number, to: number) => post<PinnedItem[]>("/pinned/move", { index, to });
export const saveSmartFolder = (folder: SmartFolder, replaces?: string) =>
  post<PinnedItem[]>("/smart-folders", { ...folder, replaces });
export const deleteSmartFolder = (name: string) =>
  api<PinnedItem[]>(`/smart-folders/${encodeURIComponent(name)}`, { method: "DELETE" });

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

/** Open a result: the local file if we have one, else its Canvas page in the browser. */
export function openHit(hit: Hit, reveal = false) {
  return hit.path ? openPath(hit.path, { reveal }) : openUrl(hit.url ?? "/");
}

export function openCanvas(hit: Hit) {
  return openUrl(hit.url ?? "/");
}
