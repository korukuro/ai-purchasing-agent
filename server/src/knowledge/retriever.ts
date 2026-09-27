/**
 * Tiny retrieval layer over the buying SOP. Sections are chunked by heading
 * and ranked with a BM25-style keyword score. It is deliberately simple and
 * dependency-free; in production this would be embeddings in pgvector over
 * SOPs, supplier contracts and past decisions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Chunk {
  title: string;
  text: string;
  tokens: string[];
}

const STOP = new Set("a an and are as at be by for from if in is it of on or the this to with when not do".split(" "));
const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9% ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => t.replace(/(ing|es|s|ed)$/, ""));

let chunks: Chunk[] | null = null;
function load(): Chunk[] {
  if (chunks) return chunks;
  const md = readFileSync(fileURLToPath(new URL("./buying-sop.md", import.meta.url)), "utf8");
  chunks = md
    .split(/^## /m)
    .slice(1)
    .map((sec) => {
      const [title, ...rest] = sec.split("\n");
      const text = rest.join("\n").trim();
      return { title: title.trim(), text, tokens: tokenize(`${title} ${text}`) };
    });
  return chunks;
}

export function searchSop(query: string, k = 2) {
  const docs = load();
  const q = [...new Set(tokenize(query))];
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length;
  const df = (t: string) => docs.filter((d) => d.tokens.includes(t)).length;
  const scored = docs.map((d) => {
    let score = 0;
    for (const t of q) {
      const tf = d.tokens.filter((x) => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - df(t) + 0.5) / (df(t) + 0.5));
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.tokens.length / avgLen))));
    }
    return { title: d.title, text: d.text, score: Math.round(score * 100) / 100 };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k).filter((x) => x.score > 0);
}
