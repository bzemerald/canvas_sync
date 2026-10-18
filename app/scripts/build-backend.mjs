// Packs the Python backend (`canvas`) with PyInstaller into src-tauri/backend/, a folder the
// packaged app carries (tauri.bundle.json) and starts instead of the repo's virtualenv.
//   npm run build:backend     (npm run bundle runs it)
// Needs the repo's .venv, with PyInstaller: pip install -e '.[dev]'
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const tauri = join(repo, "app", "src-tauri");
const python = process.platform === "win32" ? join(repo, ".venv", "Scripts", "python.exe") : join(repo, ".venv", "bin", "python");
if (!existsSync(python)) {
  console.error(`no virtualenv at ${python}: make it first (see README.md)`);
  process.exit(1);
}

const out = join(tauri, "backend");
const work = join(tauri, "target", "pyinstaller"); // (build files, out of the way)
rmSync(out, { recursive: true, force: true });
const args = [
  "-m", "PyInstaller", join(repo, "src", "canvas_sync", "__main__.py"),
  "--name", "canvas",
  "--onedir", // (one file would unpack itself on every start: slower)
  "--contents-directory", "lib",
  "--distpath", join(work, "dist"),
  "--workpath", work,
  "--specpath", work,
  "--paths", join(repo, "src"),
  "--collect-submodules", "canvas_sync",
  "--exclude-module", "pytest",
  "--exclude-module", "_pytest",
  "--exclude-module", "tkinter",
  "--noconfirm",
  "--log-level", "WARN",
];
const run = spawnSync(python, args, { stdio: "inherit" });
if (run.status !== 0) process.exit(run.status ?? 1);
renameSync(join(work, "dist", "canvas"), out);
console.log(`backend: ${out}`);
