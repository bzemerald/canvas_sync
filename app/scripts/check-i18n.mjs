// Checks the app's words (see src/lib/i18n.ts): every Chinese string in the code goes
// through t() / tx(), and every one has English in src/lib/en.ts.
//   npm run check:i18n          list what's missing
//   npm run check:i18n -- --keys  print every key (to fill in en.ts)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;
const HAN = /[一-鿿]/;
const KEY = /\bt[x]?\(\s*"((?:[^"\\]|\\.)*)"/g;

const files = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });

const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const keys = new Map(); // key -> first place it's used
const loose = [];
for (const f of files(SRC)) {
  const rel = relative(SRC, f);
  if (rel === "lib/en.ts") continue;
  const source = readFileSync(f, "utf8");
  const original = source.split("\n");
  const code = stripComments(source);
  for (const m of code.matchAll(KEY)) if (!keys.has(m[1])) keys.set(m[1], rel);
  code.split("\n").forEach((line, i) => {
    // "i18n-ignore" on the line: meant to stay as it is (a language's own name, say).
    if (HAN.test(line.replace(KEY, "")) && !original[i].includes("i18n-ignore")) loose.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}

const enSource = readFileSync(join(SRC, "lib/en.ts"), "utf8");
const have = new Set([...enSource.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]));

if (process.argv.includes("--keys")) {
  for (const k of keys.keys()) console.log(JSON.stringify(k));
  process.exit(0);
}
const missing = [...keys].filter(([k]) => HAN.test(k) && !have.has(k));
const unused = [...have].filter((k) => !keys.has(k));
for (const l of loose) console.log(`not in t(): ${l}`);
for (const [k, where] of missing) console.log(`no English: ${JSON.stringify(k)}  (${where})`);
for (const k of unused) console.log(`unused in en.ts: ${JSON.stringify(k)}`);
console.log(`${keys.size} strings, ${missing.length} without English, ${loose.length} not in t(), ${unused.length} unused`);
process.exit(missing.length || loose.length ? 1 : 0);
