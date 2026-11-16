// Checks the app's words (see src/lib/i18n.ts): every string in t() / tx() / tn() has
// Chinese in src/lib/zh.ts, and no Chinese is left in the code outside zh.ts.
//   npm run check:i18n          list what's missing
//   npm run check:i18n -- --keys  print every key (to fill in zh.ts)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const HAN = /[一-鿿]/;
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
// t("key"), tx("key"), tn("one", "key"); inBoth("key") in Found.tsx says a word in both languages.
const KEY = new RegExp(String.raw`\b(?:tx?|inBoth)\(\s*${STR}|\btn\(\s*${STR}\s*,\s*${STR}`, "g");
const keyOf = (m) => m[1] ?? m[3];

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
  const rel = relative(SRC, f).replaceAll("\\", "/");
  if (rel === "lib/zh.ts") continue;
  const source = readFileSync(f, "utf8");
  const original = source.split("\n");
  const code = stripComments(source);
  for (const m of code.matchAll(KEY)) if (!keys.has(keyOf(m))) keys.set(keyOf(m), rel);
  code.split("\n").forEach((line, i) => {
    // "i18n-ignore" on the line: meant to stay as it is (a language's own name, words people type).
    if (HAN.test(line) && !original[i].includes("i18n-ignore")) loose.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}

const zhSource = readFileSync(join(SRC, "lib/zh.ts"), "utf8");
const have = new Set([...zhSource.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]));

if (process.argv.includes("--keys")) {
  for (const k of keys.keys()) console.log(JSON.stringify(k));
  process.exit(0);
}
const missing = [...keys].filter(([k]) => /\p{L}/u.test(k) && !have.has(k));
const unused = [...have].filter((k) => !keys.has(k));
for (const l of loose) console.log(`not in t(): ${l}`);
for (const [k, where] of missing) console.log(`no Chinese: ${JSON.stringify(k)}  (${where})`);
for (const k of unused) console.log(`unused in zh.ts: ${JSON.stringify(k)}`);
console.log(`${keys.size} strings, ${missing.length} without Chinese, ${loose.length} not in t(), ${unused.length} unused`);
process.exit(missing.length || loose.length ? 1 : 0);
