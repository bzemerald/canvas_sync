// What to mark on a page opened from search: what a query's words look like in text, as a regular
// expression. It's kept as its source, on the view (MainWindow), so it can come from the search
// window and be there again on going back. Words are told apart as the index does (search.py:
// `_prep`, `_fts_term`). Components/Marked.tsx does the marking.
import { alternatives } from "./find";
import { CJK, type Part, ROMAN, type Reading, type Vocabulary, little, seriesNear, singular } from "./query";

const CJK_CHARS = "\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff";
const LATIN = `[^\\P{L}${CJK_CHARS}]`; // a letter that's not Chinese, say: 期中midterm考试 has the word midterm
/** Between blocks of a page: a word's parts aren't found across it. */
export const BLOCK_BREAK = "￼";
const BETWEEN = `[^\\p{L}\\p{N}${BLOCK_BREAK}]{0,3}`;
const TOKENS = new RegExp(`[${CJK_CHARS}]|\\p{L}+|\\p{N}+`, "gu");
const DIGITS = /^\p{N}+$/u;

const tokensOf = (text: string) => text.toLowerCase().match(TOKENS) ?? [];

/** Text's words, with what may come between them, and nothing of a longer word on either side. */
function inner(tokens: string[]) {
  return tokens.map((t) => (DIGITS.test(t) ? `0*${t}` : t)).join(BETWEEN);
}
function before(token: string) {
  return CJK.test(token) ? "" : DIGITS.test(token) ? "(?<!\\p{N})" : `(?<!${LATIN})`;
}
function after(token: string, prefix: boolean) {
  if (CJK.test(token)) return "";
  if (DIGITS.test(token)) return "(?!\\p{N})";
  return prefix && token.length >= 3 ? `${LATIN}*` : `(?!${LATIN})`; // ("lec" is lecture; "ps" isn't psychology)
}
function asPattern(text: string, prefix: boolean): string | null {
  const tokens = tokensOf(text);
  if (!tokens.length) return null;
  return before(tokens[0]!) + inner(tokens) + after(tokens.at(-1)!, prefix);
}

/** One of a series, by any name it goes by, with its number: "hw 3" is Homework 3 and Problem Set
 * #3, not Homework 30; "Midterm II", "第3讲". */
function seriesPatterns(name: string, n: number, vocab: Vocabulary): string[] {
  const names = new Set([name, ...alternatives(name, vocab.abbreviations)]);
  for (const s of vocab.series.keys()) if (seriesNear(name, s, vocab.abbreviations) !== null) names.add(s);
  const roman = Object.entries(ROMAN).find(([, v]) => v === n)?.[0];
  const numbers = `(?:0*${n}(?!\\p{N})${roman ? `|${roman}(?!${LATIN})` : ""})`;
  return [...names].flatMap((s) => {
    const tokens = tokensOf(singular(s));
    if (!tokens.length) return [];
    const said = `${before(tokens[0]!)}${inner(tokens)}${CJK.test(tokens.at(-1)!) ? "" : "s?"}${BETWEEN}${numbers}`;
    return CJK.test(s) ? [said, `第\\s*0*${n}\\s*[次个]?\\s*${inner(tokens)}`] : [said]; // i18n-ignore
  });
}

/** What a part of a query looks like in text: only what it says to find, not what narrows it down
 * (a course, a kind, a time, a status). */
function partPatterns(p: Part, vocab: Vocabulary): (string | null)[] {
  if (p.role === "series") return seriesPatterns(p.name, p.n, vocab);
  if (p.role !== "word") return [];
  const word = p.text.toLowerCase();
  if (p.quoted) return [asPattern(word, false)];
  return [word, ...alternatives(word, vocab.abbreviations)].map((w) => asPattern(w, true));
}

/** The regular expression's source for what `reading` finds (undefined: nothing to mark).
 * `snippet`: what a result said matched, which is marked too, as it is. */
export function markPattern(reading: Reading, vocab: Vocabulary, snippet: { text: string; match: boolean }[] = []): string | undefined {
  // (Little words only when there's nothing else, as for the index.)
  const parts = reading.parts.some((p) => !little(p)) ? reading.parts.filter((p) => !little(p)) : reading.parts;
  const patterns = [
    ...parts.flatMap((p) => partPatterns(p, vocab)),
    ...snippet.filter((s) => s.match && s.text.trim().length >= 2).map((s) => asPattern(s.text, false)),
  ].filter((x): x is string => !!x);
  // (The longest first: "problem set 3" before "set 3".)
  return patterns.length ? [...new Set(patterns)].sort((a, b) => b.length - a.length).join("|") : undefined;
}

export const compiled = (pattern: string) => new RegExp(pattern, "giu");

/** One piece of a page's text, and whether it starts a new block. */
export interface Piece {
  text: string;
  block: boolean;
}

/** Where a pattern is found in text in pieces: a match may go across pieces of one block
 * (<strong>Midterm</strong> 2), not across blocks. Each is from [piece, offset] to [piece, offset]. */
export function locate(pieces: Piece[], re: RegExp): { from: [number, number]; to: [number, number] }[] {
  const starts: number[] = [];
  let text = "";
  pieces.forEach((p) => {
    if (p.block && text) text += BLOCK_BREAK;
    starts.push(text.length);
    text += p.text;
  });
  // The piece a place in the text is in (`end`: the one it ends, rather than the one it starts).
  const at = (i: number, end: boolean): [number, number] => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (end ? starts[mid] < i : starts[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return [lo, i - starts[lo]];
  };
  return [...text.matchAll(re)].filter((m) => m[0].length).map((m) => ({ from: at(m.index, false), to: at(m.index + m[0].length, true) }));
}
