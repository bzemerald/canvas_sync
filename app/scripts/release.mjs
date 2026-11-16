// Starts a release: writes the version everywhere it's kept, dates CHANGELOG.md's Unreleased as
// this version (its notes; there must be some), commits, and tags v<version>.
//   npm run release -- 0.2.0
// Pushing the tag (git push origin main v0.2.0) is what builds it: .github/workflows/release.yml
// makes the Mac and Windows apps and a draft release on GitHub; publishing that draft is what
// the apps' Check for updates sees.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGELOG, dated, notes } from "./changelog.mjs";

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

// What's new in it: Unreleased, which becomes the version's part (the release's notes).
const changelog = readFileSync(CHANGELOG, "utf8");
if (!notes(changelog, "Unreleased")) {
  console.error("CHANGELOG.md's Unreleased is empty: write what changed first");
  process.exit(1);
}
const now = new Date();
const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");

// Where the version is written: each pattern's first group is what comes before it.
const files = [
  ["app/src-tauri/tauri.conf.json", /^(\s*"version": ")[^"]+/m], // (what Check for updates compares)
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

writeFileSync(CHANGELOG, dated(changelog, version, today));

git("add", "CHANGELOG.md", ...new Set(files.map(([f]) => f)));
git("commit", "-m", `Version ${version}`);
git("tag", `v${version}`);
console.log(`committed and tagged v${version}. To build and publish a draft release:\n  git push origin ${git("branch", "--show-current")} v${version}`);
