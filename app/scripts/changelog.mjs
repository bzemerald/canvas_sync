// CHANGELOG.md's parts: a version's notes (its "## <version>" part), and Unreleased dated as a
// version (by release.mjs).
//   node app/scripts/changelog.mjs 0.4.0   prints that version's notes (the release workflow's)
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHANGELOG = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));

/** What's under "## <name>" (a version, or "Unreleased"), up to the next "## "; null: no such part. */
export function notes(text, name) {
  const lines = text.split(/\r?\n/);
  const heading = new RegExp(`^## ${name.replace(/\./g, "\\.")}(\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

/** Unreleased becomes "## <version> — <date>", under a new, empty Unreleased. */
export function dated(text, version, date) {
  return text.replace(/^## Unreleased[^\S\r\n]*(\r?\n)/m, `## Unreleased$1$1## ${version} — ${date}$1`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2]?.replace(/^v/, "");
  const found = version && notes(readFileSync(CHANGELOG, "utf8"), version);
  if (!found) {
    console.error(`CHANGELOG.md has no notes for ${version ?? "(no version given)"}`);
    process.exit(1);
  }
  console.log(found);
}
