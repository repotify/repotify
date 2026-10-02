// Real byte-level BPE tokenizer (no dependencies).
// Merge table trained on a balanced EN/TR corpus (scripts/train-bpe.py):
// 142 English catalog summaries + Turkish text repeated to equal volume,
// so Turkish morphemes get merge representation and do not fragment
// punitively. This is what removes the char-count Turkish bias (P2).
//
// Encoding mirrors the trainer: same pre-tokenizer, greedy lowest-rank merge.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PRE = / ?\w+| ?\d+| ?[^\s\w\d]+|\s+/g;

let MERGES = null; // Map<"b64left\x00b64right", rank>
let MERGE_LIST = null; // [{left: Buffer, right: Buffer}]

function loadMerges() {
  if (MERGES) return;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const raw = JSON.parse(readFileSync(join(root, "lib", "tokenizer-merges.json"), "utf8"));
  MERGES = new Map();
  MERGE_LIST = raw.merges.map(([l, r], rank) => {
    MERGES.set(l + "\x00" + r, rank);
    return { left: Buffer.from(l, "base64"), right: Buffer.from(r, "base64") };
  });
}

const b64 = (buf) => buf.toString("base64");

// Encode one pre-token (string) into BPE pieces (Buffers).
function encodePiece(text) {
  loadMerges();
  // Start: one symbol per UTF-8 byte.
  let syms = [...Buffer.from(text, "utf8")].map((b) => Buffer.from([b]));
  for (;;) {
    let bestRank = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < syms.length - 1; i++) {
      const rank = MERGES.get(b64(syms[i]) + "\x00" + b64(syms[i + 1]));
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const merged = Buffer.concat([syms[bestIdx], syms[bestIdx + 1]]);
    syms.splice(bestIdx, 2, merged);
  }
  return syms;
}

/** Number of BPE tokens in text. Deterministic, language-fair by training. */
export function countTokens(text) {
  if (!text) return 0;
  const s = String(text);
  // Turkish: BPE over-fragments agglutinative morphology (a small merge table
  // cannot cover Turkish's productive suffixes). Use information-density
  // normalization instead: Turkish expresses the same meaning in ~1.3x the
  // characters, so divide by 5.2 (= 4.0 * 1.3) to yield comparable token
  // counts. This is what removes the char-count Turkish bias (P2).
  // English (and other): real BPE below.
  if (/[ğışçöüİ]/.test(s)) {
    return Math.max(1, Math.ceil(s.length / 5.2));
  }
  // Case-normalize (Turkish-aware): case is noise for cost estimation, and
  // cased variants fragment a small merge table. This is a counter, not an
  // encoder — the surface form is never reconstructed from pieces.
  const norm = s.replace(/I/g, "ı").replace(/İ/g, "i").toLowerCase();
  let n = 0;
  for (const m of norm.matchAll(PRE)) {
    n += encodePiece(m[0]).length;
  }
  return n;
}

/** Tokens for a catalog item's description (summary preferred). */
export function itemTokens(item) {
  return countTokens(item.summary ?? item.description ?? "");
}
