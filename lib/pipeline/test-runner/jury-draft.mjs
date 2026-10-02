// E3 jury rules, v1 — coded as DRAFT (FAZ 2.2).
// The jury is the expensive layer: three jurors from three different model
// families, median + majority voting, no debate rounds, temperature 0 with
// varied-seed repetition. Aggregation reuses pipeline/jury.mjs, which is the
// canonical median/voting implementation; this module only fixes the v1
// protocol around it.
import { parseVerdict, aggregate, JURY_PROMPT_VERSION, buildJuryPrompt } from "../../../pipeline/jury.mjs";

// The draft protocol, versioned so the cache key changes if it does.
export const JURY_RULES_V1 = {
  status: "draft",
  jurors: 3,
  distinctFamilies: true,
  aggregation: "median+voting",
  debate: false,
  temperature: 0,
  repetitionsPerJuror: 2,
  seedStrategy: "varied-seed",
  // v1 cost gate: the jury runs only on seed (editorial) or explicitly
  // critical items, never on every discovered item.
  costGate: "seed-or-critical-only",
  version: "1",
};

export function juryEligible(item = {}) {
  return Boolean(item.editorial || item.critical);
}

// Pick up to n jurors with distinct families, in a deterministic order.
// candidates: [{ provider, model, family }]
export function selectSeedJurors(candidates = [], { n = JURY_RULES_V1.jurors } = {}) {
  const seen = new Set();
  const jurors = [];
  const ordered = [...candidates].sort((a, b) =>
    String(a.family).localeCompare(String(b.family)) || String(a.model).localeCompare(String(b.model)),
  );
  for (const c of ordered) {
    if (seen.has(c.family)) continue;
    seen.add(c.family);
    jurors.push({ provider: c.provider, model: c.model, family: c.family });
    if (jurors.length >= n) break;
  }
  return jurors;
}

// Run the draft jury. chat({ model, messages, temperature, seed, maxTokens })
// is injected so unit tests stay offline; the production adapter lives in
// ./nvidia-cli.mjs. Returns the aggregated jury object or null.
export async function runJuryDraft(item, text, { chat, jurors, taxonomy, seeds = [7, 42], maxTokens = 4000, log = () => {} }) {
  if (!chat || !jurors?.length || !taxonomy) return null;
  const messages = buildJuryPrompt(item, text, taxonomy);
  const perJuror = [];
  for (const j of jurors) {
    const verdicts = [];
    for (const seed of seeds.slice(0, JURY_RULES_V1.repetitionsPerJuror)) {
      let reply;
      try {
        reply = await chat({ model: j.model, messages, temperature: JURY_RULES_V1.temperature, seed, maxTokens });
      } catch (error) {
        log(`jury-draft: ${j.model} seed ${seed} failed: ${error.message}`);
        continue;
      }
      const v = parseVerdict(reply, taxonomy);
      if (v) verdicts.push(v);
      else log(`jury-draft: ${j.model} seed ${seed} gave no valid verdict`);
    }
    if (!verdicts.length) continue;
    // One representative verdict per juror: the median-quality one across its seeds.
    verdicts.sort((a, b) => a.quality - b.quality);
    const qualities = verdicts.map((v) => v.quality);
    const seedSpread = qualities.length > 1 ? Math.max(...qualities) - Math.min(...qualities) : 0;
    perJuror.push({ juror: j, verdict: verdicts[Math.floor(verdicts.length / 2)], seedSpread });
  }
  if (!perJuror.length) return null;
  const jury = aggregate(
    perJuror.map((p) => p.verdict),
    perJuror.map((p) => p.juror.model),
  );
  // Temperature 0 is not deterministic: graders flip borderline verdicts even
  // at T=0 (Tamba 2026; arXiv:2603.28304). The per-juror seed spread is
  // surfaced so the next phase can distrust an unstable verdict instead of
  // treating a point estimate as truth.
  const maxSeedSpread = Math.max(...perJuror.map((p) => p.seedSpread));
  return {
    ...jury,
    rules: JURY_RULES_V1.status,
    rulesVersion: JURY_RULES_V1.version,
    promptVersion: JURY_PROMPT_VERSION,
    jurorFamilies: perJuror.map((p) => p.juror.family),
    seedSpread: Math.round(maxSeedSpread * 1000) / 1000,
    unstable: maxSeedSpread > UNSTABLE_SEED_SPREAD,
    temperature: JURY_RULES_V1.temperature,
    debate: false,
  };
}

// A juror whose own seeds disagree by more than this on quality is unstable:
// its verdict is a coin flip on a borderline item, not a measurement.
// NOTE: with only 2 seeds per juror this estimator is noisy and UNCALIBRATED.
// `unstable` is metadata only — it must NOT gate scoring or presentation
// until the threshold is calibrated on a labeled set (then move to 3 seeds).
export const UNSTABLE_SEED_SPREAD = 0.3;

export { JURY_PROMPT_VERSION };
