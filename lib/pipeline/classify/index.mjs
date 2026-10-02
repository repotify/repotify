// Coarse classifier (FAZ 2.5 + FAZ 3.8): test results + seed context ->
// 3-5 coarse capability labels. v1 is intentionally dumb: it trusts the
// jury first, falls back to keyword overlap with the taxonomy, and lets the
// seed context (manifest deps) boost stack-related capabilities. No LLM.
export const CLASSIFY_VERSION = "1";
const MAX_LABELS = 5;

const STOP = new Set("a,an,the,of,for,with,and,or,to,in,on,into,from,by,its,it,is,are,was,be,as,at,this,that,these,those,you,your,our,we,they,their,them,its,has,have,had,will,would,can,could,should,may,might,do,does,did,not,no,yes,if,then,than,so,such,via,using,use,used,uses,when,where,how,what,which,who,also,more,most,less,very,just,only,own,new,old,high,low,all,any,each,every,both,few,many,much,other,another,some,anyone,everyone".split(","));

export function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

function capabilityTokens(id, entry) {
  const label = entry?.label ?? id;
  return [...new Set([...tokens(id), ...tokens(label)])];
}

// Jury verdicts are the strongest signal; everything else is a fallback.
export function fromJury(jury, taxonomy) {
  const out = [];
  for (const id of jury?.capabilities ?? []) {
    if (taxonomy?.capabilities?.[id]) out.push({ id, sources: ["jury"], weight: 1 });
  }
  return out;
}

export function fromText(text, taxonomy) {
  const words = new Set(tokens(text));
  if (!words.size || !taxonomy?.capabilities) return [];
  const out = [];
  for (const [id, entry] of Object.entries(taxonomy.capabilities)) {
    const toks = capabilityTokens(id, entry);
    if (!toks.length) continue;
    const hit = toks.filter((t) => words.has(t)).length;
    const overlap = hit / toks.length;
    if (overlap >= 0.5 && hit > 0) out.push({ id, sources: ["text"], weight: Math.round(overlap * 100) / 100 });
  }
  return out;
}

// Seed context: manifest dependency names that name a stack BOOST capabilities
// whose id/label already matched another signal. Deliberately boost-only: a
// dep name must never conjure a capability out of thin air (a requirements.txt
// mentioning sqlalchemy says nothing about whether the skill does database
// work — the skill text has to say that first).
export function fromContext(context, taxonomy) {
  if (!context?.manifests?.length || !taxonomy?.capabilities) return [];
  const deps = new Set(context.manifests.flatMap((m) => m.deps ?? []).map((d) => String(d).toLowerCase()));
  if (!deps.size) return [];
  const stackIds = Object.keys(taxonomy.stacks ?? {});
  const matchedStacks = stackIds.filter((s) => [...deps].some((d) => d.includes(s) || s.includes(d.split("/").pop())));
  if (!matchedStacks.length) return [];
  const out = [];
  for (const [id, entry] of Object.entries(taxonomy.capabilities)) {
    const toks = new Set(capabilityTokens(id, entry));
    if (matchedStacks.some((s) => toks.has(s))) out.push({ id, sources: ["context"], weight: 0.2, boostOnly: true });
  }
  return out;
}

export function classifyCoarse({ testResult = {}, context = null, taxonomy = null } = {}) {
  const pool = new Map();
  const add = (c) => {
    const cur = pool.get(c.id);
    if (cur) {
      cur.weight = Math.min(1, Math.round((cur.weight + c.weight) * 100) / 100);
      for (const s of c.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
    } else {
      pool.set(c.id, { id: c.id, sources: [...c.sources], weight: c.weight });
    }
  };
  for (const c of fromJury(testResult.jury, taxonomy)) add(c);
  for (const c of fromText(testResult.text, taxonomy)) add(c);
  // Context boosts are boost-only: they attach to labels that already have
  // text or jury evidence, never create labels on their own.
  for (const c of fromContext(context, taxonomy)) {
    const cur = pool.get(c.id);
    if (cur) add(c);
  }

  const labels = [...pool.values()]
    .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_LABELS);
  // Confidence reflects signal strength: a 3-family jury verdict is the
  // expensive strong signal; three or more agreeing heuristic labels are
  // medium; anything thinner is low (and the next phase must treat it so).
  const hasJury = (testResult.jury?.capabilities?.length ?? 0) > 0;
  const confidence = hasJury ? "high" : labels.length >= 3 ? "medium" : "low";
  return { labels, confidence, version: CLASSIFY_VERSION };
}
