// v1 presentation: default REJECT path, conflict resolution, context budget,
// value-per-character set selection.
//
// Default reject: when classification is uncertain the system recommends
// NOTHING and says why — a wrong install costs more than a missed one.
// Uncertain means: no candidates at all, or the best candidate is below the
// fit floor, or the demand is thin and the top two are indistinguishable.
// Otherwise: resolve exclusions (keep the higher scorer), then fill the context
// budget in value-per-character order.

// Operating points, set by hand and checked by the eval scenarios (test/eval), not fitted:
export const MIN_V1_SCORE = 0.25; // below this, no recommendation is trustworthy
export const DEFAULT_BUDGET_CHARS = 6000; // context budget for the set
const LOW_CONFIDENCE_FLAGS = new Set(["thin-demand", "low-margin", "unmet-requirements", "off-graph", "via-fallback", "caution-verdict"]);

export function uncertaintyOf(allScored, demand) {
  // Core items fit every project by definition, so they say nothing about how
  // well the demand was understood: judge confidence on the optional items.
  const scored = allScored.filter((s) => s.item.tier !== "core");
  if (!scored.length) return { uncertain: true, reason: "no-candidates" };
  const top = scored[0];
  if (top.score < MIN_V1_SCORE) return { uncertain: true, reason: "below-fit-floor", detail: `${top.item.id} scores ${top.score}` };
  const thin = (demand.capabilitiesWanted ?? []).length < 2 && !(demand.answered ?? []).length;
  const tied = scored.length > 1 && scored[0].score - scored[1].score < 0.08;
  if (thin && tied) return { uncertain: true, reason: "thin-demand-tie", detail: `${scored[0].item.id} vs ${scored[1].item.id}` };
  // One weak signal, no need, no stack, nothing answered: even a clear winner is
  // a guess about the project. The core backbone is still offered (see present()).
  if (thin && !(demand.needs ?? []).length && !(demand.stacks ?? []).length) return { uncertain: true, reason: "thin-demand", detail: `${(demand.capabilitiesWanted ?? []).length} wanted capability, no answers` };
  return { uncertain: false, reason: null };
}

// Drop the lower scorer of each exclusion pair. Deterministic.
export function resolveExclusions(scored, exclusions = []) {
  const byId = new Map(scored.map((s) => [s.item.id, s]));
  const dropped = [];
  const dead = new Set();
  for (const [a, b] of exclusions) {
    if (dead.has(a) || dead.has(b)) continue;
    const sa = byId.get(a);
    const sb = byId.get(b);
    if (!sa || !sb) continue;
    const loser = sa.score === sb.score ? (sa.item.id < sb.item.id ? sb : sa) : sa.score < sb.score ? sa : sb;
    dead.add(loser.item.id);
    dropped.push({ id: loser.item.id, reason: `excluded-by:${loser.item.id === a ? b : a}` });
  }
  return { kept: scored.filter((s) => !dead.has(s.item.id)), dropped };
}

// P2: value per TOKEN, not per character. descriptionChars measures the full
// skill doc (what gets installed); we convert to tokens with a calibrated
// divisor: 4.0 chars/token for English (standard BPE rate, validated in
// test/tokenizer.test.mjs), 5.2 for Turkish (4.0 * 1.3 information-density
// ratio — removes the char-count Turkish bias). Linear in descriptionChars,
// so the ranking is stable; the units are now honest tokens.
const estimateTokens = (item) => {
  const chars = item.descriptionChars ?? 200;
  const summary = item.summary ?? "";
  const isTurkish = /[ğışçöüİ]/.test(summary);
  return Math.max(12, Math.ceil(chars / (isTurkish ? 5.2 : 4.0)));
};

const valuePerToken = (s) => s.score / estimateTokens(s.item);

// Coverage-gate experiment (2026-10-01, Ahmet: "try both paths, pick the most
// sensible"). The strict gate ("no-new-coverage": drop an item when every one
// of its wanted caps/needs/stacks is already served) was dropping must-include
// items in 3-4 of 7 harness scenarios — coarse tokens like "security" or
// "frontend-ui" get marked served by the first-selected item and everything
// sharing that token is vetoed, even high-fit items.
//   REPOTIFY_COVERAGE_VARIANT=strict  — the original binary gate (kept for rollback).
//   REPOTIFY_COVERAGE_VARIANT=loose   — Variant A: items within SCORE_MARGIN of
//                                       the top score bypass the gate (the gate
//                                       is a tiebreaker for the long tail, not
//                                       a veto over top-fit items).
//   REPOTIFY_COVERAGE_VARIANT=jaccard — (default) Variant B: graded redundancy — drop an
//                                       item only when its max pairwise Jaccard
//                                       similarity (over demand-wanted tokens)
//                                       with any selected item is >= JACCARD_DROP,
//                                       unless it ties the blocker on score and
//                                       adds a new capability kind (tie-contender
//                                       escape). "Same need" becomes a graded
//                                       similarity, not "shares 1 token".
//   REPOTIFY_COVERAGE_VARIANT=hybrid  — Variant A+B: admit when the item is
//                                       near-top by score OR not a near-
//                                       duplicate; drop only when it is BOTH
//                                       outside the score band AND substantially
//                                       similar to a selected item.
export const COVERAGE_VARIANTS = ["strict", "loose", "jaccard", "hybrid"];
export const SCORE_MARGIN = 0.12; // Variant A: bypass band below the top score (calibration debt)
export const JACCARD_DROP = 0.6; // Variant B: drop at >= this max pairwise similarity (calibration debt)

export function coverageVariant() {
  const v = process.env.REPOTIFY_COVERAGE_VARIANT ?? "jaccard";
  return COVERAGE_VARIANTS.includes(v) ? v : "jaccard";
}
// Coverage gate: beyond the core backbone, an item joins the set only if it
// covers a wanted capability, need, or stack nothing selected so far covers.
// This keeps the set justified: every row earns its context characters.
//
// Variants (see COVERAGE_VARIANTS above):
// - strict: the original binary gate.
// - loose: top-fit items (score within SCORE_MARGIN of the best) bypass.
// - jaccard: drop only on graded near-duplication (max pairwise Jaccard >=
//   JACCARD_DROP over wanted tokens vs any selected item), with a tie-contender
//   escape (tied score + new capability kind admits both).
// Gate decision log (2026-10-01, BACKLOG: gate karar loglama). Every candidate
// the coverage gate evaluates gets a structured decision record — never
// silent, always debuggable. The record flows into the Stage 0 telemetry
// recommendation event as `gate_decisions` (see trackRecommendationV1 in
// src/cli.mjs and lib/telemetry/schema.mjs).
export const GATE_REASONS = Object.freeze({
  CORE_TIER_PASS: "CORE_TIER_PASS", // core tier bypasses the gate entirely
  SCORE_BAND_PASS: "SCORE_BAND_PASS", // loose/hybrid: within SCORE_MARGIN of top
  JACCARD_PASS: "JACCARD_PASS", // jaccard/hybrid: max pairwise Jaccard < JACCARD_DROP
  STRICT_PASS: "STRICT_PASS", // strict gate: covers a new wanted token
  NO_NEW_COVERAGE_STRICT: "NO_NEW_COVERAGE_STRICT", // strict gate drop
  NO_NEW_COVERAGE_JACCARD: "NO_NEW_COVERAGE_JACCARD", // jaccard drop (jaccard + blocker set)
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED", // passed the gate, exceeded context budget
  EXEMPT_PASS: "EXEMPT_PASS", // loadout pick for an empty project, or expertise for a stack the project uses
  CLUSTER_TAKEN: "CLUSTER_TAKEN", // a selected item already does this job (same cluster or exclusive group)
  BELOW_FIT_FLOOR: "BELOW_FIT_FLOOR", // optional item whose demand fit is too weak for the default set
});

// An optional item joins the default set only when it fits the project this well
// (the v1 engine's proven floor: a capability match on an off-stack item scores
// below it, a capability match on a matching or any-stack item above it).
export const MIN_DEFAULT_FIT = 0.6;

// installed: scored rows of the catalog items already in the project. They are not
// picked again, but they hold their job, what they cover counts as served, and
// their descriptions already take context in every session.
// jaccardDrop: the near-duplicate threshold, an option so the sensitivity sweep
// (test/harness/jaccard-sensitivity.mjs) runs this very loop at other values.
export function selectSet(scored, { budgetChars = DEFAULT_BUDGET_CHARS, demand = {}, installed = [], jaccardDrop = JACCARD_DROP } = {}) {
  const variant = coverageVariant();
  const wantedCaps = new Set(demand.capabilitiesWanted ?? []);
  const wantedNeeds = new Set(demand.needs ?? []);
  const wantedStacks = new Set(demand.stacks ?? []);
  const wantedTokensOf = (item) =>
    new Set(
      [...(item.capabilities ?? []), ...(item.needs ?? []), ...(item.stacks ?? [])].filter(
        (t) => wantedCaps.has(t) || wantedNeeds.has(t) || wantedStacks.has(t),
      ),
    );
  // Similarity substrate for the jaccard variant (js-frontend triage, 2026-10-01).
  // Graded demand-coverage similarity runs over demand-wanted tokens (unchanged,
  // well-calibrated: pilot recall 0.857). A drop on Jaccard >= 0.6 stands —
  // except the tie-contender escape: exact score tie (scores round to 3
  // decimals) + a capability kind the blocker lacks + near the top of the
  // ranking (reuses SCORE_MARGIN). Then the gate's tiebreak (description length
  // via valuePerToken) is arbitrary — admit both rather than kill a top
  // contender. (react-best-practices tied composition-patterns at 0.859 = joint
  // top with wanted-Jaccard 1.0; react-performance is not a kind of
  // component-architecture — dropping the must-include was wrong.) Mid-pack
  // ties stay dropped: admitting them wastes budget (measured: python-api
  // typescript-pro/spec-miner tied at 0.558 and starved semgrep).
  // Broader fixes were measured and rejected: full-token and capabilities∪wanted
  // substrates dilute the redundancy signal globally — sets balloon and the
  // context budget starves must-include items (cli-tool, python-api regressed).
  const servedCaps = new Set();
  const servedNeeds = new Set();
  const servedStacks = new Set();
  const coverageOf = (s) => ({
    caps: (s.item.capabilities ?? []).filter((c) => wantedCaps.has(c) && !servedCaps.has(c)),
    needs: (s.item.needs ?? []).filter((n) => wantedNeeds.has(n) && !servedNeeds.has(n)),
    stacks: (s.item.stacks ?? []).filter((x) => wantedStacks.has(x) && !servedStacks.has(x)),
  });
  const markServed = (s) => {
    for (const c of (s.item.capabilities ?? []).filter((x) => wantedCaps.has(x))) servedCaps.add(c);
    for (const n of (s.item.needs ?? []).filter((x) => wantedNeeds.has(x))) servedNeeds.add(n);
    for (const x of (s.item.stacks ?? []).filter((y) => wantedStacks.has(y))) servedStacks.add(x);
  };
  // Variant B state: wanted-token sets of selected items for Jaccard,
  // kept with the item id, its score, and its capability set (for the
  // tie-contender rule) so drops can name their blocker.
  const selectedTokenSets = []; // [{ id, tokens: Set, score, caps: Set }]
  const jaccard = (a, b) => {
    if (!a.size && !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const topScore = scored.length ? Math.max(...scored.map((s) => s.score)) : 0;
  const nearTop = (s) => s.score >= topScore - SCORE_MARGIN;
  // Max pairwise Jaccard vs the selected set, with the blocker's id, score,
  // and capability set. Similarity runs over demand-wanted tokens.
  const maxSimilarity = (s) => {
    const t = wantedTokensOf(s.item);
    let best = { jaccard: 0, blocker: null, blockerScore: -Infinity, blockerCaps: new Set() };
    for (const st of selectedTokenSets) {
      const j = jaccard(t, st.tokens);
      if (j > best.jaccard) {
        best = { jaccard: j, blocker: st.id, blockerScore: st.score, blockerCaps: st.caps };
      }
    }
    return best;
  };
  const round4 = (x) => Math.round(x * 10000) / 10000;
  const strictDecision = (s) => {
    const cov = coverageOf(s);
    const pass = cov.caps.length > 0 || cov.needs.length > 0 || cov.stacks.length > 0;
    return {
      pass,
      reason: pass ? GATE_REASONS.STRICT_PASS : GATE_REASONS.NO_NEW_COVERAGE_STRICT,
      jaccard: null,
      blocker: null,
    };
  };
  const jaccardDecision = (s) => {
    // No demand overlap at all: fall back to the strict gate's verdict so
    // items with zero demand overlap can't sneak in via similarity 0.
    if (!wantedTokensOf(s.item).size) return strictDecision(s);
    const { jaccard: j, blocker, blockerScore, blockerCaps } = maxSimilarity(s);
    const jr = round4(j);
    if (j >= jaccardDrop) {
      // Near-duplicate of the blocker. Tie-contender escape (js-frontend
      // triage): an exact score tie (scores round to 3 decimals, so a tie is
      // genuinely indistinguishable) + a capability kind the blocker lacks +
      // near the top of the ranking. Then the gate's tiebreak (description
      // length via valuePerToken) is arbitrary — admit both rather than kill
      // a top contender. (react-best-practices tied composition-patterns at
      // 0.859 = joint top with wanted-Jaccard 1.0; react-performance is not a
      // kind of component-architecture.) Mid-pack ties stay dropped: admitting
      // them wastes budget (python-api: typescript-pro/spec-miner tied at 0.558
      // and starved semgrep).
      const tied = s.score === blockerScore;
      const candCaps = new Set(s.item.capabilities ?? []);
      const addsKind = [...candCaps].some((c) => !blockerCaps.has(c));
      if (!(tied && addsKind && nearTop(s))) {
        return { pass: false, reason: GATE_REASONS.NO_NEW_COVERAGE_JACCARD, jaccard: jr, blocker };
      }
    }
    return { pass: true, reason: GATE_REASONS.JACCARD_PASS, jaccard: jr, blocker };
  };
  // The gate's verdict for one candidate, as a structured decision record.
  // Behavior identical to the old eligible()/strictEligible()/jaccardPass()
  // closure trio — only the shape of the answer changed.
  const loadoutIds = new Set(demand.loadoutIds ?? []);
  const gateDecision = (s) => {
    if (s.item.tier === "core") {
      return { pass: true, reason: GATE_REASONS.CORE_TIER_PASS, jaccard: null, blocker: null };
    }
    // Coverage is about optional extras. A loadout pick is the curated start for
    // an empty project, and a stack expert is the reason a stack item exists:
    // neither competes on coverage (the one-per-cluster rule still applies).
    const stackMatch = s.item.tier === "stack" && (s.item.stacks ?? []).some((x) => wantedStacks.has(x));
    if (loadoutIds.has(s.item.id) || stackMatch) {
      return { pass: true, reason: GATE_REASONS.EXEMPT_PASS, jaccard: null, blocker: null };
    }
    if (variant === "loose") {
      if (nearTop(s)) return { pass: true, reason: GATE_REASONS.SCORE_BAND_PASS, jaccard: null, blocker: null };
      return strictDecision(s);
    }
    if (variant === "jaccard") return jaccardDecision(s);
    if (variant === "hybrid") {
      if (nearTop(s)) return { pass: true, reason: GATE_REASONS.SCORE_BAND_PASS, jaccard: null, blocker: null };
      const jd = jaccardDecision(s);
      if (jd.pass) return jd;
      const sd = strictDecision(s);
      if (sd.pass) return sd;
      // Failed both: the graded near-duplication is the diagnostic reason —
      // report it (with jaccard + blocker) instead of the binary strict drop.
      return jd;
    }
    return strictDecision(s);
  };

  // One item per job: a cluster (and an exclusive capability group) is served
  // by the first, best item that takes it. Core items claim their clusters first.
  const exclusiveGroups = demand.exclusiveGroups ?? {};
  const groupsOf = (item) => (item.capabilities ?? []).map((c) => exclusiveGroups[c]).filter(Boolean);
  const takenClusters = new Map(); // cluster -> id
  const takenGroups = new Map(); // exclusive group -> id
  const jobDecision = (s) => {
    if (s.item.cluster && takenClusters.has(s.item.cluster)) return { pass: false, reason: GATE_REASONS.CLUSTER_TAKEN, jaccard: null, blocker: takenClusters.get(s.item.cluster) };
    const g = groupsOf(s.item).find((x) => takenGroups.has(x));
    if (g) return { pass: false, reason: GATE_REASONS.CLUSTER_TAKEN, jaccard: null, blocker: takenGroups.get(g) };
    if (s.item.tier !== "core" && s.parts && s.parts.classFit < MIN_DEFAULT_FIT) return { pass: false, reason: GATE_REASONS.BELOW_FIT_FLOOR, jaccard: null, blocker: null };
    return null;
  };
  const takeJob = (s) => {
    if (s.item.cluster) takenClusters.set(s.item.cluster, s.item.id);
    for (const g of groupsOf(s.item)) takenGroups.set(g, s.item.id);
  };

  let used = 0;
  const selected = [];
  const skipped = [];
  const gateDecisions = [];
  for (const s of installed) {
    used += s.item.descriptionChars ?? 200;
    markServed(s);
    takeJob(s);
    if (variant === "jaccard" || variant === "hybrid") {
      selectedTokenSets.push({ id: s.item.id, tokens: wantedTokensOf(s.item), score: s.score, caps: new Set(s.item.capabilities ?? []) });
    }
  }
  const core = scored.filter((s) => s.item.tier === "core");
  // Who does a job is decided by fit first (the best item for the cluster wins);
  // value per token then orders the winners for the context budget. A
  // hand-vetted item (origin "curated") beats a lab find in its cluster: the lab
  // fills the jobs nobody curated, it does not replace a vetted pick on a score
  // edge (image-to-code edged out frontend-design on a web app that way).
  const curatedFirst = (a, b) => (a.item.origin === "lab" ? 1 : 0) - (b.item.origin === "lab" ? 1 : 0);
  const byScore = scored.filter((s) => s.item.tier !== "core").sort((a, b) => curatedFirst(a, b) || b.score - a.score || (a.item.id < b.item.id ? -1 : 1));
  const winners = new Set();
  const clusterSeen = new Set([...core, ...installed].map((s) => s.item.cluster).filter(Boolean));
  for (const s of byScore) {
    if (s.item.cluster && clusterSeen.has(s.item.cluster)) continue;
    if (s.item.cluster) clusterSeen.add(s.item.cluster);
    winners.add(s);
  }
  const rest = [
    ...[...winners].sort((a, b) => valuePerToken(b) - valuePerToken(a) || (a.item.id < b.item.id ? -1 : 1)),
    ...byScore.filter((s) => !winners.has(s)),
  ];
  const ordered = [...core, ...rest];
  for (const s of ordered) {
    const gd = jobDecision(s) ?? gateDecision(s);
    if (!gd.pass) {
      skipped.push({ id: s.item.id, reason: gd.reason, jaccard: gd.jaccard, blocker: gd.blocker, variant });
      gateDecisions.push({
        skill_id: s.item.id, decision: "dropped", reason: gd.reason,
        variant, jaccard: gd.jaccard, blocker: gd.blocker,
      });
      continue;
    }
    const cost = s.item.descriptionChars ?? 200;
    if (used + cost <= budgetChars) {
      used += cost;
      selected.push(s);
      markServed(s);
      takeJob(s);
      if (variant === "jaccard" || variant === "hybrid") {
        selectedTokenSets.push({
          id: s.item.id,
          tokens: wantedTokensOf(s.item),
          score: s.score,
          caps: new Set(s.item.capabilities ?? []),
        });
      }
      gateDecisions.push({
        skill_id: s.item.id, decision: "selected", reason: gd.reason,
        variant, jaccard: gd.jaccard, blocker: gd.blocker,
      });
    } else {
      skipped.push({
        id: s.item.id, reason: GATE_REASONS.BUDGET_EXCEEDED,
        jaccard: gd.jaccard, blocker: gd.blocker, variant,
      });
      gateDecisions.push({
        skill_id: s.item.id, decision: "dropped", reason: GATE_REASONS.BUDGET_EXCEEDED,
        variant, jaccard: gd.jaccard, blocker: gd.blocker,
      });
    }
  }
  return { selected, skipped, budget: { used, limit: budgetChars }, gateDecisions, variant };
}

export function present(scored, demand, { budgetChars = DEFAULT_BUDGET_CHARS, exclusions = [], installed = [] } = {}) {
  const uncertainty = uncertaintyOf(scored, demand);
  if (uncertainty.uncertain) {
    // No confident project-specific picks. The core backbone is still safe to
    // offer: it fits every project and is what the agent would install anyway.
    const core = scored.filter((s) => s.item.tier === "core");
    const { selected, budget } = selectSet(core, { budgetChars, demand, installed });
    return {
      decision: "reject",
      set: selected.map((s) => s.item.id),
      rows: selected.map((s) => rowOf(s)),
      budget,
      reason: uncertainty.reason,
      detail: uncertainty.detail ?? null,
      advice: "answer one question or add a dependency so the demand signal is stronger",
      gateDecisions: [],
    };
  }
  const { kept, dropped } = resolveExclusions(scored, exclusions);
  const { selected, skipped, budget, gateDecisions, variant } = selectSet(kept, { budgetChars, demand, installed });
  const rows = selected.map(rowOf);
  return {
    decision: "recommend",
    set: rows.map((r) => r.id),
    rows,
    budget,
    dropped: [...dropped, ...skipped],
    gateDecisions,
    coverageVariant: variant,
    lowConfidence: rows.filter((r) => r.lowConfidence).map((r) => r.id),
    reason: null,
  };
}

// The candidate table the agent reads: what is installed, the default set, then
// the best remaining candidate for each job nobody holds yet (a hand-vetted item
// before a lab find, as in the set). One row per job and no conflicting pair, so
// whatever the agent adds from it keeps the setup conflict-free.
export const MAX_TABLE_ROWS = 30;

export function candidateTable(scored, { set = [], installed = [], exclusiveGroups = {}, exclusions = [], alternates = true, maxRows = MAX_TABLE_ROWS } = {}) {
  const byId = new Map(scored.map((s) => [s.item.id, s]));
  const jobsOf = (item) => [
    ...(item.cluster ? [`cluster:${item.cluster}`] : []),
    ...(item.capabilities ?? []).map((c) => exclusiveGroups[c]).filter(Boolean).map((g) => `group:${g}`),
  ];
  const taken = new Set();
  const listed = new Set();
  const rows = [];
  const add = (s, mark) => {
    rows.push({ id: s.item.id, score: s.score, reasons: s.reasons ?? [], default: mark === "default", installed: mark === "installed" });
    listed.add(s.item.id);
    for (const j of jobsOf(s.item)) taken.add(j);
  };
  for (const s of installed) add(s, "installed");
  for (const id of set) if (byId.has(id) && !listed.has(id)) add(byId.get(id), "default");
  if (alternates) {
    const clashes = (id) => exclusions.some(([a, b]) => (a === id && listed.has(b)) || (b === id && listed.has(a)));
    const curatedFirst = (a, b) => (a.item.origin === "lab" ? 1 : 0) - (b.item.origin === "lab" ? 1 : 0);
    for (const s of [...scored].sort((a, b) => curatedFirst(a, b) || b.score - a.score || (a.item.id < b.item.id ? -1 : 1))) {
      if (rows.length >= maxRows) break;
      if (listed.has(s.item.id) || jobsOf(s.item).some((j) => taken.has(j)) || clashes(s.item.id)) continue;
      add(s, "alternate");
    }
  }
  return rows.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

function rowOf(s) {
  return {
    id: s.item.id,
    type: s.item.type,
    tier: s.item.tier,
    score: s.score,
    parts: s.parts,
    flags: s.flags,
    lowConfidence: s.flags.some((f) => LOW_CONFIDENCE_FLAGS.has(f)),
    reasons: s.reasons,
    valuePerToken: Math.round(valuePerToken(s) * 10000) / 10000,
  };
}
