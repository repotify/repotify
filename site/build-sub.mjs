#!/usr/bin/env node
// FAZ 8: builds the v2 sub-pages (English-only): /skills/, /skills/<id>/,
// /leaderboard/. Pre-rendered at build time from dist/assets/data/*.json so the
// pages work without JavaScript. Zero dependencies.
// Exported as buildSubPages({ out, version }); also runnable standalone against
// an existing dist dir.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const slug = (id) => String(id).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const fnum = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US"));

function chrome({ title, desc, root, path, body, version, extraHead = "" }) {
  return `<!doctype html>
<html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Repotify</title><meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://repotify.github.io/repotify/${path}">
<link rel="icon" href="${root}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${root}assets/styles.css?v=${esc(version)}">
<link rel="stylesheet" href="${root}assets/sub.css?v=${esc(version)}">
${extraHead}</head>
<body>
<div class="bg" aria-hidden="true"><span class="grid"></span></div>
<header class="nav">
  <a class="brand" href="${root}"><span>repotify</span></a>
  <nav class="links" aria-label="Main">
    <a href="${root}skills/">Skills</a>
    <a href="${root}leaderboard/">Leaderboard</a>
  </nav>
  <div class="nav-end"><a class="gh" href="https://github.com/repotify/repotify"><span>GitHub</span></a></div>
</header>
<main id="main" class="sub">
${body}
</main>
<footer class="foot">
  <div class="foot-brand"><div><strong>repotify</strong><p>Measured skills for coding agents.</p></div></div>
  <nav aria-label="Footer"><a href="${root}">Home</a><a href="${root}skills/">Skills</a><a href="${root}leaderboard/">Leaderboard</a><a href="https://github.com/repotify/repotify">GitHub</a></nav>
  <p class="fine">MIT · v${esc(version)}</p>
</footer>
<script src="${root}assets/app.js?v=${esc(version)}" defer></script>
</body></html>`;
}

const secBadge = (level, title = "") => {
  const cls = { verified: "verified", caution: "caution", quarantined: "quarantined", rejected: "rejected" }[level] ?? "unknown";
  return `<span class="seclv ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(level)}</span>`;
};

// S14: measurement badge tooltip — scan level + finding count + scan date,
// so the badge is evidence, not decoration.
const secTitle = (s) => {
  const d = s.security.scannedAt ? String(s.security.scannedAt).slice(0, 10) : "not scanned";
  return `Rule-based security scan: ${s.security.level} · ${s.security.findings ?? 0} findings · ${d}`;
};

// S14: compact jury sub-score line for cards (detail pages keep the full
// meter bars). quality/specificity/maintenance are 3-model 0–1 medians.
function dimsLine(j) {
  if (j.quality == null || j.specificity == null || j.maintenance == null) {
    return `<span class="dims" title="Jury sub-scores pending — the 3-model jury has not scored this entry yet">jury sub-scores <b>—</b></span>`;
  }
  const tip = `Jury sub-scores (3-model medians, 0–1): quality ${j.quality.toFixed(2)} · specificity ${j.specificity.toFixed(2)} · maintenance ${j.maintenance.toFixed(2)}`;
  return `<span class="dims" title="${esc(tip)}">Q <b>${j.quality.toFixed(2)}</b> · S <b>${j.specificity.toFixed(2)}</b> · M <b>${j.maintenance.toFixed(2)}</b></span>`;
}

// S14: reusable empty-state block. Infrastructure only: the catalog blind
// spots (Three.js/WebGL, FPS, HUD, terminal aesthetics, character modeling)
// get no public "coming soon" section yet — S6–S10 scan reports will feed them
// as the catalog grows. First live use: the skills-index filter no-results
// state. `body` is plain text (escaped); `action` may carry pre-built markup.
export function emptyState({ id = "", title, body = "", action = "", hidden = true } = {}) {
  if (!title) throw new Error("emptyState: title is required");
  return `<div class="empty"${id ? ` id="${esc(id)}"` : ""}${hidden ? " hidden" : ""}>
<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7" stroke-linecap="round"/></svg>
<h3>${esc(title)}</h3>
${body ? `<p class="muted">${esc(body)}</p>` : ""}
${action}
</div>`;
}

function skillCard(s, root) {
  const caps = s.capabilities.slice(0, 4).map((c) => `<li>${esc(c)}</li>`).join("");
  const scoreLine = s.scoreExpired
    ? `<span class="score expired" title="Score expired — pending re-scan">score <b>expired</b></span>`
    : `<span class="score" title="Jury mean: quality, specificity, maintenance">score <b>${s.jury.mean == null ? "—" : s.jury.mean.toFixed(2)}</b></span>`;
  return `<article class="card skill-card" data-id="${esc(s.id)}" data-name="${esc(s.name.toLowerCase())}" data-caps="${esc(s.capabilities.join(" ").toLowerCase())}">
  <div class="skill-top"><h3><a href="${root}skills/${slug(s.id)}/">${esc(s.name)}</a></h3>${secBadge(s.security.level, secTitle(s))}</div>
  <p class="skill-sum">${esc(s.summary)}</p>
  <div class="skill-meta">${scoreLine}
  ${dimsLine(s.jury)}
  <span class="exp" title="Scores are re-run on a 30-day cycle">${s.scoreExpired ? "expired " + esc(s.scoreExpiresAt) : "valid until " + esc(s.scoreExpiresAt)}</span></div>
  ${caps ? `<ul class="tags">${caps}</ul>` : ""}
</article>`;
}

function skillsIndex(skills, meta, version) {
  // This page lives at /skills/ — site-root-relative links need "../".
  const cards = skills.map((s) => skillCard(s, "../")).join("\n");
  const body = `
<section class="subhead">
  <h1>Skill catalog</h1>
  <p class="section-lead">${meta.count} skills, each one scanned for risk and scored by a 3-model jury. Scores expire after 30 days and are re-run — an expired score is never served silently.</p>
  <p class="search"><input id="q" type="search" placeholder="Filter ${meta.count} skills…" aria-label="Filter skills" autocomplete="off"></p>
  <p class="countline" aria-live="polite"><span id="shown">${meta.count}</span> of ${meta.count} shown · catalog ${esc(meta.catalogVersion)}</p>
</section>
<section class="grid3" id="cards">${cards}</section>
${emptyState({ id: "noresults", title: "No skills match that filter.", body: "Try a shorter keyword, or a capability tag like web or security." })}
<script>
(() => {
  const q = document.getElementById("q"), cards = [...document.querySelectorAll(".skill-card")],
        shown = document.getElementById("shown"), none = document.getElementById("noresults");
  q.addEventListener("input", () => {
    const t = q.value.trim().toLowerCase(); let n = 0;
    for (const c of cards) {
      const hit = !t || c.dataset.name.includes(t) || c.dataset.caps.includes(t) || c.dataset.id.includes(t);
      c.hidden = !hit; if (hit) n++;
    }
    shown.textContent = n; none.hidden = n > 0;
  });
})();
</script>`;
  return chrome({ path: "skills/", title: "Skill catalog", desc: `All ${meta.count} Repotify skills with security level, jury scores and capability tags.`, root: "../", body, version });
}

function bar(label, v) {
  if (v == null) return `<div class="meter"><span>${esc(label)}</span><div class="track"><i style="width:0%"></i></div><em>—</em></div>`;
  return `<div class="meter"><span>${esc(label)}</span><div class="track"><i style="width:${Math.round(v * 100)}%"></i></div><em>${v.toFixed(2)}</em></div>`;
}

function skillDetail(s, version) {
  const j = s.jury;
  const models = j.models.map((m) => `<li><code dir="ltr">${esc(m)}</code></li>`).join("");
  const tags = (xs) => xs.length ? `<ul class="tags">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">None listed.</p>`;
  const expiredNote = s.scoreExpired
    ? `<p class="expired-banner"><b>Score expired ${esc(s.scoreExpiresAt)}.</b> The jury scores below are the last known values, shown for reference only — they are pending re-scan and must not be treated as current.</p>`
    : "";
  const body = `
<nav class="crumb"><a href="../">Skills</a> / <span>${esc(s.name)}</span></nav>
<section class="subhead detail-head">
  <div><h1>${esc(s.name)}</h1>
  <p class="skill-id"><code dir="ltr">${esc(s.id)}</code> · tier <b>${esc(s.tier ?? "—")}</b>${s.repo ? ` · <a href="https://github.com/${esc(s.repo)}">source repo</a>` : ""}${s.license ? ` · ${esc(s.license)}` : ""}</p></div>
  ${secBadge(s.security.level, secTitle(s))}
</section>
<p class="section-lead">${esc(s.summary)}</p>
<div class="grid2">
  <section class="card">
    <h2>Test results</h2>
    ${expiredNote}
    <p class="bignum">${j.mean == null ? "—" : j.mean.toFixed(2)}<span> jury mean${s.scoreExpired ? " (expired)" : ""}</span></p>
    ${bar("quality", j.quality)}${bar("specificity", j.specificity)}${bar("maintenance", j.maintenance)}
    <dl class="facts">
      <div><dt>Jury agreement</dt><dd>${j.agreement == null ? "—" : pct(j.agreement)}</dd></div>
      <div><dt>Scored</dt><dd>${esc(s.scoreScoredAt)}</dd></div>
      <div><dt>Score expires</dt><dd>${esc(s.scoreExpiresAt)}${s.scoreExpired ? " — <b>expired</b>" : ""}</dd></div>
    </dl>
    <p class="muted small">Scores are re-run on a 30-day cycle (same TTL as the pipeline's expensive scoring layer). An expired score is re-scanned before it is served again — never silently.</p>
    ${models ? `<h3>Jury models</h3><ul class="models">${models}</ul>` : ""}
  </section>
  <section class="card">
    <h2>Security scan</h2>
    <dl class="facts">
      <div><dt>Level</dt><dd>${secBadge(s.security.level, secTitle(s))}</dd></div>
      <div><dt>Scanned at</dt><dd>${esc(s.security.scannedAt ? s.security.scannedAt.slice(0, 10) : "—")}</dd></div>
      <div><dt>Findings</dt><dd>${fnum(s.security.findings)}</dd></div>
      <div><dt>Upstream commit</dt><dd><code dir="ltr">${esc((s.commit ?? "—").slice(0, 12))}</code></dd></div>
      <div><dt>Description length</dt><dd>${fnum(s.descriptionChars)} chars</dd></div>
      <div><dt>Files fingerprinted</dt><dd>${fnum(s.files)}</dd></div>
    </dl>
    <h3>Capabilities</h3>${tags(s.capabilities)}
    <h3>Stacks</h3>${tags(s.stacks)}
    ${s.needs.length ? `<h3>Pairs with</h3>${tags(s.needs)}` : ""}
    ${s.conflicts.length ? `<h3>Conflicts</h3>${tags(s.conflicts)}` : ""}
  </section>
</div>
<section class="card comments" id="comments" data-skill="${esc(s.id)}">
  <h2>Community experiences</h2>
  <p class="muted small">What actually happened when you used this skill. No stars, no ratings — just experience reports.</p>
  <p class="protolabel"><b>Local prototype:</b> your comment is stored in <b>this browser only</b> — other visitors cannot see it. The queue below is a moderation simulation (try it with <code dir="ltr">?demo=moderation</code> in the URL); in production a human moderator approves via signed entries shipped with the site build.</p>
  <div id="clist"><p class="muted">Loading…</p></div>
  <h3>Share your experience</h3>
  <form id="cform">
    <label>Name (optional)<input name="name" maxlength="60" autocomplete="nickname"></label>
    <label>Project type
      <select name="projectType">
        <option value="web">web app</option><option value="cli">CLI</option><option value="api">API / backend</option>
        <option value="docs">docs / writing</option><option value="data">data / ML</option><option value="other">other</option>
      </select></label>
    <label>What happened?<textarea name="text" required maxlength="2000" rows="4" placeholder="Which task, what the skill did, what you'd do differently…"></textarea></label>
    <button class="btn primary" type="submit">Submit for moderation</button>
    <p class="muted small">Prototype: stored in this browser only, pending moderation. See the <a href="https://github.com/repotify/repotify/blob/site/polish/site/COMMENTS-DESIGN.md">moderation design</a>.</p>
  </form>
  <details class="modq"><summary>Moderation queue (local prototype)</summary><div id="mqueue"><p class="muted">Empty.</p></div></details>
</section>
<script>window.__REPOTIFY_ROOT="../../";</script>
<script src="../../assets/comments.js?v=${esc(version)}" defer></script>`;
  return chrome({ path: `skills/${slug(s.id)}/`, title: s.name, desc: s.summary || `Repotify skill: ${s.name}`, root: "../../", body, version });
}

// S14: "How we measure" — the leaderboard's methodology, from measured
// results. Sources: coverage-gate pilot (test/harness/pilot-coverage.mjs,
// test/harness/runs/coverage-pilot.jsonl — n=30/arm, synthetic take-all
// mock-agent, 210 matched pairs) + real-world benchmark (4 projects x 4
// variants, 3-model jury coverage/precision/coherence medians). Numbers are
// post-triage (tie-contender escape, 2026-10-01): jaccard recall 0.857->1.000.
function methodSection() {
  return `
<section class="card method" id="how-we-measure">
  <h2>How we measure</h2>
  <p class="muted small">No stars, no ratings. Every number on this page is measured — this is the machinery behind it.</p>
  <h3>1 · Rule scan, then a 3-model jury</h3>
  <p>Every catalog entry first passes a rule-based security scan (<code dir="ltr">verified</code> / <code dir="ltr">caution</code> / <code dir="ltr">quarantined</code> / <code dir="ltr">rejected</code>). A 3-model jury then scores <b>quality</b>, <b>specificity</b> and <b>maintenance</b> as 0–1 medians — the mean is the score you see on skill pages. <b>Agreement</b> (how much the models concur) gates the score: below 0.6 it discounts quality. Scores expire after 30 days and are re-run; an expired score is flagged, never served silently.</p>
  <h3>2 · The coverage gate — measured in a pilot</h3>
  <p>Recommendation sets are context-budgeted, so a coverage gate decides which skills stay. Four gate variants ran in a pilot (30 runs per arm, synthetic take-all mock agent) on must-have recall:</p>
  <div class="twrap"><table class="mini">
    <thead><tr><th>Gate variant</th><th>Recall</th><th>Precision</th><th>F1</th><th>nDCG</th><th>Avg. set size</th></tr></thead>
    <tbody>
      <tr><td><code dir="ltr">strict</code></td><td>0.500</td><td>0.129</td><td>0.194</td><td>0.214</td><td>7.7</td></tr>
      <tr><td><code dir="ltr">loose</code></td><td>0.786</td><td>0.098</td><td>0.169</td><td>0.214</td><td>12.0</td></tr>
      <tr class="win"><td><code dir="ltr">jaccard</code> (default)</td><td>1.000</td><td>0.115</td><td>0.201</td><td>0.270</td><td>12.4</td></tr>
      <tr><td><code dir="ltr">hybrid</code></td><td>0.857</td><td>0.082</td><td>0.146</td><td>0.214</td><td>14.7</td></tr>
    </tbody>
  </table></div>
  <p class="muted small">Jaccard reached recall 1.000 after a targeted triage fix (tie-contender escape) that repaired a real miss — react-best-practices dropped for a look-alike skill — with no scenario regressing. Hybrid was eliminated: bigger sets crowded must-have items out of the context budget. A separate real-world check (4 realistic projects x 4 variants, judged by a 3-model jury: nemotron-3-super-120b-a12b, gemma-4-31b-it, gpt-oss-20b) agrees — average jury coverage: jaccard 7.0 &gt; loose 6.6 &gt; hybrid 6.4 &gt; strict 5.5. Decision: <b>jaccard is the default</b> — an item whose max pairwise Jaccard overlap with an already-selected skill reaches 0.6 is dropped. Reversible at any time via the <code dir="ltr">REPOTIFY_COVERAGE_VARIANT</code> environment variable.</p>
  <h3>3 · Every gate decision leaves an audit trail</h3>
  <p>Drops are never silent. Each gate decision carries a reason code — <code dir="ltr">JACCARD_PASS</code>, <code dir="ltr">NO_NEW_COVERAGE_JACCARD</code>, <code dir="ltr">STRICT_PASS</code>, <code dir="ltr">NO_NEW_COVERAGE_STRICT</code>, <code dir="ltr">SCORE_BAND_PASS</code>, <code dir="ltr">CORE_TIER_PASS</code>, <code dir="ltr">BUDGET_EXCEEDED</code> — and Jaccard drops additionally record the measured overlap value and the blocking skill's id. The decisions are logged with recommendation telemetry, so any set we ever served can be re-examined. No fake precision: the gate's own calibration debt (the 0.6 threshold sits on a narrow working window) is tracked openly in the repo, not hidden.</p>
  <h3>4 · Per-skill rankings wait for fleet data</h3>
  <p>Ranking individual skills needs fleet telemetry — installs, usage, retention — aggregated and delayed. Until that data crosses the threshold below, the fleet section stays parked: we show no per-skill rankings rather than invented ones.</p>
</section>`;
}

function leaderboardPage(lb, version) {
  const m = lb.meta;
  const byScenario = {};
  for (const r of lb.rows) (byScenario[r.scenario] ??= []).push(r);
  // Pragmatist tur2 (c1): cells show mean + observed min–max spread across the
  // runs (descriptive), never a bootstrap 95% CI (fake precision at n=3).
  const mm = (v, lo, hi) => `${v.toFixed(2)} <span class="ci">[${lo.toFixed(2)}–${hi.toFixed(2)}]</span>`;
  const tables = Object.entries(byScenario).map(([sc, rows]) => `
  <h3 class="scn">${esc(sc)}</h3>
  <div class="twrap"><table class="lb">
    <thead><tr><th>Arm</th><th>Routing recall <span class="ci">min–max</span></th><th>Task score <span class="ci">min–max</span></th><th>Token cost <span class="ci">mean est.</span></th><th>Runs</th><th>Notes</th></tr></thead>
    <tbody>${rows.map((r) => `<tr${r.arm === "repotify" ? ' class="hl"' : ""}>
      <td><code dir="ltr">${esc(r.arm)}</code></td>
      <td>${mm(r.routing_recall, r.routing_min, r.routing_max)}</td>
      <td>${mm(r.task_score, r.task_min, r.task_max)}</td>
      <td>${fnum(r.tokens_est)} tok</td>
      <td>${r.n}</td>
      <td class="muted small">${r.note ? esc(r.note) : (r.arm === "repotify" ? "Repotify-recommended set" : "—")}</td>
    </tr>`).join("")}</tbody>
  </table></div>`).join("");
  const body = `
<section class="subhead">
  <h1>Effectiveness leaderboard</h1>
  <p class="section-lead">Which skill <b>sets</b> actually work, per project type — measured in our own harness, not marketed. This table compares routing strategies (arms), <b>not individual skills</b>: per-skill top-tier ranking needs fleet telemetry (usage + retention), which ships in a later phase behind the flag below.</p>
</section>
<section class="card datanote">
  <h2>About this data</h2>
  <dl class="facts">
    <div><dt>Source</dt><dd><code dir="ltr">${esc(m.source)}</code></dd></div>
    <div><dt>What it is</dt><dd>${esc(m.label)}</dd></div>
    <div><dt>Policy</dt><dd>${esc(m.dataPolicy)}</dd></div>
    <div><dt>Generated</dt><dd>${esc(m.generatedAt.slice(0, 10))}</dd></div>
  </dl>
  <p class="muted small">Pilot scale: 3 runs per cell — each cell shows the mean and the observed min–max spread across the 3 runs, not a confidence interval; rankings at this n are noise, not verdicts. The <code dir="ltr">none</code> arm is a negative control (no skill cards shown), so its routing recall is 0 by construction, not a finding. Arms compare routing strategies, never individual catalog skills.</p>
  <p class="muted small"><b>Why only Series 3?</b> ${esc(m.seriesNote ?? "")}</p>
</section>
${tables}
${methodSection()}
<section class="card fleet" id="fleet">
  <h2>Fleet leaderboard <span class="flag">flag: off</span></h2>
  <p>Usage + retention across real installs — effectiveness, not popularity. Unlocks when fleet telemetry crosses the data threshold (<b>${esc(m.fleetThreshold)}</b> installs, FAZ 9). Until then this section stays parked: no fake numbers.</p>
</section>`;
  return chrome({ path: "leaderboard/", title: "Effectiveness leaderboard", desc: "Arm-level harness results per project type (Series 3, pilot scale) — routing strategies compared, not individual skills.", root: "../", body, version });
}

export function buildSubPages({ out, version, today = new Date().toISOString().slice(0, 10) }) {
  const dataDir = join(out, "assets", "data");
  const { skills, meta } = JSON.parse(readFileSync(join(dataDir, "skills.json"), "utf8"));
  const lb = JSON.parse(readFileSync(join(dataDir, "leaderboard.json"), "utf8"));
  const skillsDir = join(out, "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, "index.html"), skillsIndex(skills, meta, version));
  for (const s of skills) {
    const d = join(skillsDir, slug(s.id));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "index.html"), skillDetail(s, version));
  }
  const lbDir = join(out, "leaderboard");
  mkdirSync(lbDir, { recursive: true });
  writeFileSync(join(lbDir, "index.html"), leaderboardPage(lb, version));
  return { out, skills: skills.length, pages: skills.length + 2, ids: skills.map((s) => slug(s.id)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const v = process.argv.indexOf("--version");
  const r = buildSubPages({ out: i > 0 ? resolve(process.argv[i + 1]) : join(here, "dist"), version: v > 0 ? process.argv[v + 1] : "dev" });
  console.log(`sub-pages: ${r.pages} pages → ${r.out}`);
}
