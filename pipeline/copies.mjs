// Copies. Popular skills travel: collections carry them verbatim, with a line changed, or as they were three revisions
// ago; leaked system prompts carry vendor skills nobody licensed. The catalog lists a skill once, from the source that
// most likely wrote it, and a copy of a skill that cannot be listed (its license, its scan) is not listed either. Two
// questions are answered here, with no model and no network: how alike two SKILL.md texts are, and which of two
// sources is the likelier origin.

// The words of a skill's instructions: the frontmatter (the part copies edit most) and markup left out.
export function wordsOf(text) {
  const body = String(text ?? "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return (body.trim().length >= 200 ? body : String(text ?? "")).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Every run of four words, as a set: two texts that share many of theirs say the same thing in the same words.
export const SHINGLE = 4;
export function shingles(text) {
  const w = wordsOf(text);
  const out = new Set();
  if (w.length < SHINGLE) {
    if (w.length) out.add(w.join(" "));
    return out;
  }
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]} ${w[i + 3]}`);
  return out;
}

// How alike two shingle sets are, 0..1: `jaccard` is the share of all runs both have; `contained` is the share of the
// shorter text found in the longer, which stays high when a copy adds or drops a section.
export function overlap(a, b) {
  if (!a.size || !b.size) return { jaccard: 0, contained: 0 };
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let both = 0;
  for (const s of small) if (large.has(s)) both++;
  return { jaccard: both / (a.size + b.size - both), contained: both / small.size };
}

// The operating points, read off the store (2026-10-03, 1,009 pairs of same-named skills with different texts, see
// docs/BENCHMARKS.md): the pairs fall into two heaps, 523 below a jaccard of 0.1 (namesakes) and 402 at 0.5 or above,
// with 84 in between, and every pair read between 0.25 and 0.7 was one skill at two revisions. So two skills of the
// same name are one skill from a fifth of shared runs on; without the name, only when most of the text is shared.
export const COPY = Object.freeze({
  sameName: Object.freeze({ jaccard: 0.2, contained: 0.4, short: 0.5 }),
  anyName: Object.freeze({ jaccard: 0.5, contained: 0.8, short: 0.9 }),
  // A text of a few lines shares its runs with anything on the subject: only its jaccard counts, at the `short` bar.
  minShingles: 30,
});
export function isCopy(a, b, { sameName = false } = {}) {
  const bar = sameName ? COPY.sameName : COPY.anyName;
  const o = overlap(a, b);
  if (Math.min(a.size, b.size) < COPY.minShingles) return o.jaccard >= bar.short;
  return o.jaccard >= bar.jaccard || o.contained >= bar.contained;
}

// A collection of this many skill folders or more gathers other people's skills more often than it writes its own.
export const LARGE_COLLECTION = 200;
// Stars from which a repository of its own skills is taken for a source people know.
export const NOTABLE_STARS = 50;
// A repository that keeps its own skills and that people know.
export const isOwnSource = (h) => !h.large && (h.stars ?? 0) >= NOTABLE_STARS;

// Which source is the likelier origin of a skill two repositories both carry: the lower rank. In order:
//   1. a source of hand-vetted catalog items;
//   2. a folder kept as a skill, not one in a repository's own agent setup (.claude/skills: someone installed it there);
//   3. a repository whose stars the research found credible, over one flagged as inflated or for a human look;
//   4. a known repository of its own skills, over a large collection and over a repository nobody knows;
//   5. more stars; then the name, so the order is total.
// The age of a repository says nothing: one opened in 2015 may have copied the skill yesterday.
export function rankOf(h) {
  return [h.curated ? 0 : 1, h.hidden ? 1 : 0, h.flagged ? 1 : 0, isOwnSource(h) ? 0 : 1, -(h.stars ?? 0), h.repo, h.path ?? ""];
}
export function compareRank(a, b) {
  const x = rankOf(a);
  const y = rankOf(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
