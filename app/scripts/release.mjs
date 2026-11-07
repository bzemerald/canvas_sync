// Starts a release: writes the version everywhere it's kept, commits, and tags v<version>.
//   npm run release -- 0.2.0
// Pushing the tag (git push origin main v0.2.0) is what builds it: .github/workflows/release.yml
// makes the Mac and Windows apps and a draft release on GitHub; publishing that draft is what
// the apps' 检查更新 sees.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: npm run release -- <major.minor.patch>");
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
if (git("status", "--porcelain")) {
  console.error("commit or stash your changes first");
  process.exit(1);
}
if (git("tag", "--list", `v${version}`)) {
  console.error(`v${version} is tagged already`);
  process.exit(1);
}

// Where the version is written: each pattern's first group is what comes before it.
const files = [
  ["app/src-tauri/tauri.conf.json", /^(\s*"version": ")[^"]+/m], // (what 检查更新 compares)
  ["app/package.json", /^(\s*"version": ")[^"]+/m],
  ["app/package-lock.json", /^(\s*"version": ")[^"]+/m], // (the top, then the root package's)
  ["app/package-lock.json", /("packages": \{\s*"": \{\s*"name": "canvas-desktop",\s*"version": ")[^"]+/],
  ["app/src-tauri/Cargo.toml", /^(version = ")[^"]+/m],
  ["app/src-tauri/Cargo.lock", /(name = "canvas-desktop"\nversion = ")[^"]+/],
  ["pyproject.toml", /^(version = ")[^"]+/m],
  ["src/canvas_sync/__init__.py", /^(__version__ = ")[^"]+/m],
];
for (const [file, pattern] of files) {
  const path = join(repo, file);
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) {
    console.error(`no version found in ${file}`);
    process.exit(1);
  }
  writeFileSync(path, text.replace(pattern, `$1${version}`));
}

git("add", ...new Set(files.map(([f]) => f)));
git("commit", "-m", `Version ${version}`);
git("tag", `v${version}`);
console.log(`committed and tagged v${version}. To build and publish a draft release:\n  git push origin ${git("branch", "--show-current")} v${version}`);
