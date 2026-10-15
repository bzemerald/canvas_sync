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
}

export interface Course {
  id: number;
  name: string;
  code: string;
  display_code: string;
  term: string | null;
  dir: string;
}

export interface SyncState {
  phase: "idle" | "checking" | "downloading" | "indexing" | "done" | "failed";
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

export function search(q: string, opts: { limit?: number; courses?: number[] } = {}): Promise<Hit[]> {
  const params = new URLSearchParams({ q, limit: String(opts.limit ?? 50) });
  for (const c of opts.courses ?? []) params.append("course", String(c));
  return api(`/search?${params}`);
}

export const courses = () => api<Course[]>("/courses");
export const health = () => api<{ root: string; canvas: string }>("/health");
export const syncState = () => api<SyncState>("/sync");
export const startSync = () => api<SyncState>("/sync", { method: "POST" });

/** Open a result: the local file if we have one, else its Canvas page in the browser. */
export function openHit(hit: Hit, reveal = false) {
  const body = hit.path ? { path: hit.path, reveal } : { url: hit.url };
  return api("/open", { method: "POST", body: JSON.stringify(body) });
}

export function openCanvas(hit: Hit) {
  return api("/open", { method: "POST", body: JSON.stringify({ url: hit.url }) });
}
