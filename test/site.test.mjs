import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build, renderPage, LANGUAGES, BASE_URL } from "../site/build.mjs";
import { emptyState } from "../site/build-sub.mjs";
import { FLEET_INSTALL_THRESHOLD } from "../lib/telemetry/server/thresholds.mjs";

// Site builds write ~3MB per temp dir; without cleanup a day of test runs
// fills /tmp and later runs fail with ENOSPC. Track and remove them all.
const tempDirs = [];
const mkSiteDir = () => {
  const out = mkdtempSync(join(tmpdir(), "repotify-site-"));
  tempDirs.push(out);
  return out;
};
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const i18n = new URL("../site/src/i18n/", import.meta.url);
const read = (lang) => JSON.parse(readFileSync(new URL(`${lang}.json`, i18n), "utf8"));
const en = read("en");
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("every language has exactly the English keys, and the same inline code", () => {
  const files = readdirSync(i18n).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  assert.deepEqual(files, LANGUAGES.map((l) => l.code).sort(), "one file per language in the build");
  const ticks = (s) => (s.match(/`/g) ?? []).length;
  for (const l of LANGUAGES) {
    const s = read(l.code);
    assert.deepEqual(Object.keys(s).sort(), Object.keys(en).sort(), `${l.code}: keys`);
    for (const [k, v] of Object.entries(s)) {
      assert.ok(typeof v === "string" && v.trim(), `${l.code}.${k} is empty`);
      assert.equal(ticks(v), ticks(en[k]), `${l.code}.${k}: inline code differs from English`);
    }
  }
});

test("the build writes one localized page per language with SEO metadata", () => {
  const out = mkSiteDir();
  const r = build({ out, today: "2026-09-29" });
  const skillCount = JSON.parse(readFileSync(new URL("../catalog/items.json", import.meta.url), "utf8")).length;
  assert.equal(r.pages, LANGUAGES.length + skillCount + 2, "24 language pages + skill index/detail + leaderboard");
  assert.equal(r.skills, skillCount);
  for (const l of LANGUAGES) {
    const html = readFileSync(join(out, l.dir, "index.html"), "utf8");
    const url = BASE_URL + (l.dir ? `${l.dir}/` : "");
    assert.match(html, new RegExp(`<html lang="${l.code}" dir="${l.rtl ? "rtl" : "ltr"}">`), l.code);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), `${l.code}: canonical`);
    assert.equal((html.match(/<link rel="alternate" hreflang=/g) ?? []).length, LANGUAGES.length + 1, `${l.code}: hreflang + x-default`);
    assert.ok(html.includes('hreflang="x-default" href="https://repotify.github.io/repotify/"'));
    for (const tag of ['property="og:title"', 'property="og:description"', 'property="og:image"', 'name="twitter:card"', 'name="description"']) {
      assert.ok(html.includes(tag), `${l.code}: ${tag}`);
    }
    assert.ok(!/\{\{[\w:]+\}\}/.test(html) && !/\bundefined\b/.test(html), `${l.code}: leftover placeholder`);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1, `${l.code}: exactly one current language`);
    assert.ok(html.includes(`v${version}`), `${l.code}: version`);
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)[1]);
    assert.deepEqual(ld.map((x) => x["@type"]), ["SoftwareApplication", "FAQPage"]);
    assert.equal(ld[1].mainEntity.length, 6);
    assert.equal(ld[0].softwareVersion, version);
  }
  for (const f of ["styles.css", "sub.css", "app.js", "comments.js", "og.png", "favicon.svg", "apple-touch-icon.png", "jetbrains-mono-latin.woff2", "jetbrains-mono-OFL.txt"]) {
    assert.ok(existsSync(join(out, "assets", f)), f);
  }
  // FAZ 8: build-time data + sub-pages.
  for (const f of ["skills.json", "leaderboard.json", "comments.json"]) {
    assert.ok(existsSync(join(out, "assets", "data", f)), `data/${f}`);
  }
  const data = JSON.parse(readFileSync(join(out, "assets", "data", "skills.json"), "utf8"));
  assert.equal(data.meta.count, skillCount);
  assert.equal(data.skills.length, skillCount);
  const lb = JSON.parse(readFileSync(join(out, "assets", "data", "leaderboard.json"), "utf8"));
  assert.equal(lb.meta.fleetEnabled, false, "8b fleet leaderboard stays behind the flag");
  assert.equal(lb.meta.fleetThreshold, FLEET_INSTALL_THRESHOLD, "DL-045: site threshold is the frozen constant, not a literal");
  assert.ok(lb.rows.length > 0 && lb.rows.every((r) => typeof r.tokens_est === "number"), "token cost column present");
  assert.ok(existsSync(join(out, "skills", "index.html")));
  assert.ok(existsSync(join(out, "leaderboard", "index.html")));
  const firstId = data.skills[0].id;
  const detail = readFileSync(join(out, "skills", firstId, "index.html"), "utf8");
  assert.ok(detail.includes("id=\"cform\""), "skill page carries the comment form");
  assert.ok(detail.includes(data.skills[0].scoreExpiresAt), "skill page shows score expiry");
  const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
  assert.equal((sitemap.match(/<url>/g) ?? []).length, LANGUAGES.length + skillCount + 2, "sitemap covers sub-pages");
  assert.equal((sitemap.match(/<xhtml:link /g) ?? []).length, LANGUAGES.length * (LANGUAGES.length + 1));
  assert.match(readFileSync(join(out, "robots.txt"), "utf8"), /Sitemap: https:\/\/repotify\.github\.io\/repotify\/sitemap\.xml/);
  assert.ok(existsSync(join(out, "404.html")));
});

test("strings are escaped, `code` becomes <code>, and a missing string fails the build", () => {  const l = LANGUAGES[0];
  const html = renderPage("<p>{{a}}</p><i title=\"{{attr:a}}\"></i>", { ...en, a: 'Run `x` <script>"' }, l, { version: "9.9.9", all: { en } });
  assert.equal(html, '<p>Run <code>x</code> &lt;script&gt;&quot;</p><i title="Run x &lt;script&gt;&quot;"></i>');
  assert.throws(() => renderPage("{{nope}}", en, l, { version: "9.9.9", all: { en } }), /missing string "nope"/);
});

test("FAZ 8.4: no inflated copy — every language shows the real catalog count", () => {
  const out = mkSiteDir();
  build({ out, today: "2026-09-29" });
  const skillCount = JSON.parse(readFileSync(new URL("../catalog/items.json", import.meta.url), "utf8")).length;
  for (const l of LANGUAGES) {
    const html = readFileSync(join(out, l.dir, "index.html"), "utf8");
    assert.ok(!/[Tt]housands of agent skills/.test(html), `${l.code}: inflated English copy`);
    assert.ok(html.includes(`${skillCount} agent skills`) || new RegExp(`${skillCount}[^<]{0,40}`).test(html), `${l.code}: real count present`);
  }
  // every locale's hero carries its own real-count phrase (spot-check a few)
  for (const [code, dir, phrase] of [["de", "de", `${skillCount} Agent-Skills.`], ["tr", "tr", `${skillCount} ajan skill'i.`], ["ja", "ja", `${skillCount}のエージェントスキル。`]]) {
    const html = readFileSync(join(out, dir, "index.html"), "utf8");
    assert.ok(html.includes(phrase), `${code}: real-count hero`);
  }
});

test("FAZ 8.1: skill data entries carry scores, expiry and capability tags", () => {
  const out = mkSiteDir();
  build({ out, today: "2026-09-29" });
  const { skills, meta } = JSON.parse(readFileSync(join(out, "assets", "data", "skills.json"), "utf8"));
  assert.equal(skills.length, meta.count);
  for (const s of skills) {
    assert.ok(s.id && s.summary, `${s.id}: identity`);
    assert.ok(["verified", "caution", "quarantined", "rejected", "unknown"].includes(s.security.level), `${s.id}: security level`);
    assert.ok(s.jury.mean == null || (s.jury.mean >= 0 && s.jury.mean <= 1), `${s.id}: jury mean in range`);
    assert.match(s.scoreExpiresAt, /^\d{4}-\d{2}-\d{2}$/, `${s.id}: expiry date`);
    assert.ok(Array.isArray(s.capabilities), `${s.id}: capability tags`);
    assert.equal(typeof s.scoreExpired, "boolean");
  }
});

test("FAZ 8.5 (b1): comment rendering escapes every user-controlled field (XSS)", () => {
  const src = readFileSync(new URL("../site/src/comments.js", import.meta.url), "utf8");
  assert.ok(/const esc = \(s\) =>/.test(src), "escape helper defined");
  const fields = ["c.name", "c.text", "c.projectType", "c.ts", "c.id"];
  let checked = 0;
  for (const m of src.matchAll(/\$\{([^{}]*)\}/g)) {
    const expr = m[1];
    if (fields.some((f) => expr.includes(f))) {
      checked++;
      assert.ok(/^\s*esc\(/.test(expr), `unescaped user field in interpolation: \${${expr}}`);
    }
  }
  assert.ok(checked >= 5, `expected user-field interpolations to audit, found ${checked}`);
});

test("FAZ 8.5 (b2/b3): moderation buttons are demo-gated; cards carry local-only microcopy", () => {
  const src = readFileSync(new URL("../site/src/comments.js", import.meta.url), "utf8");
  assert.ok(src.includes('get("demo") === "moderation"'), "?demo=moderation gate present");
  assert.ok(/const modbtns = DEMO_MOD\s*\?\s*`[^`]*data-act="approve"[^`]*`\s*:\s*""/s.test(src),
    "Approve/Reject markup renders only when the demo flag is on");
  assert.ok(src.includes("saved in this browser only"), "local-only microcopy on comment cards");
  const out = mkSiteDir();
  build({ out, today: "2026-09-29" });
  const builtJs = readFileSync(join(out, "assets", "comments.js"), "utf8");
  assert.ok(builtJs.includes("?demo=moderation"), "built comments.js carries the demo gate");
  const firstId = JSON.parse(readFileSync(join(out, "assets", "data", "skills.json"), "utf8")).skills[0].id;
  const detail = readFileSync(join(out, "skills", firstId, "index.html"), "utf8");
  assert.ok(!detail.includes("data-act="), "no Approve/Reject buttons in static skill HTML");
  assert.ok(detail.includes("this browser only"), "skill page labels the prototype local-only");
});

test("FAZ 8.5 (c1/c2/c3): leaderboard shows min-max spread, series-3 note, arm-level framing", () => {
  const out = mkSiteDir();
  build({ out, today: "2026-09-29" });
  const lbHtml = readFileSync(join(out, "leaderboard", "index.html"), "utf8");
  assert.ok(!lbHtml.includes("95% CI"), "c1: no 95% CI columns");
  assert.ok(lbHtml.includes("min–max"), "c1: min–max label present");
  assert.ok(/<span class="ci">\[\d\.\d\d–\d\.\d\d\]<\/span>/.test(lbHtml), "c1: cells render mean [min–max]");
  const lb = JSON.parse(readFileSync(join(out, "assets", "data", "leaderboard.json"), "utf8"));
  assert.ok(lb.rows.length > 0);
  for (const r of lb.rows) {
    for (const [lo, mean, hi, k] of [[r.routing_min, r.routing_recall, r.routing_max, "routing"], [r.task_min, r.task_score, r.task_max, "task"]]) {
      assert.ok(typeof lo === "number" && typeof hi === "number", `${r.scenario}/${r.arm}: ${k} min/max present`);
      assert.ok(lo <= mean && mean <= hi, `${r.scenario}/${r.arm}: ${k} min<=mean<=max`);
    }
  }
  assert.ok(lbHtml.includes("Why only Series 3?"), "c2: one-line series-3 explanation");
  assert.ok(lbHtml.includes("not individual skills"), "c3: arm-level framing");
  assert.ok(!/best skill|top skill|winning skill|ranked #1/i.test(lbHtml), "c3: no per-skill superiority claims");
});

test("FAZ 8.5 (d1): sub-pages are English-only with working internal links", () => {
  const out = mkSiteDir();
  build({ out, today: "2026-09-29" });
  const firstId = JSON.parse(readFileSync(join(out, "assets", "data", "skills.json"), "utf8")).skills[0].id;
  for (const p of ["skills/index.html", "leaderboard/index.html", `skills/${firstId}/index.html`]) {
    const html = readFileSync(join(out, p), "utf8");
    assert.match(html, /<html lang="en" dir="ltr">/, `${p}: html lang=en`);
    assert.ok(!/hreflang=/.test(html), `${p}: no hreflang claims`);
    assert.ok(!/langmenu/i.test(html), `${p}: no language switcher`);
    const dir = join(out, dirname(p));
    for (const m of html.matchAll(/href="([^"#]+)"/g)) {
      const h = m[1].split(/[?#]/)[0];
      if (!h || /^(https?:|mailto:)/.test(h)) continue;
      const target = resolve(dir, h);
      assert.ok(existsSync(target) || existsSync(join(target, "index.html")), `${p}: dead link ${h}`);
    }
  }
});

test("S14: leaderboard carries a How-we-measure section with pilot numbers and gate transparency", () => {
  const out = mkSiteDir();
  build({ out, today: "2026-09-29" });
  const lbHtml = readFileSync(join(out, "leaderboard", "index.html"), "utf8");
  assert.ok(lbHtml.includes('id="how-we-measure"'), "method section anchor");
  for (const needle of [
    "How we measure",
    "3-model jury",
    "NO_NEW_COVERAGE_JACCARD",
    "STRICT_PASS",
    "BUDGET_EXCEEDED",
    "REPOTIFY_COVERAGE_VARIANT",
    "0.270", // post-triage jaccard nDCG
    "1.000", // post-triage jaccard recall
    "blocking skill",
  ]) {
    assert.ok(lbHtml.includes(needle), `method section: ${needle}`);
  }
  // pilot table: all four variants, jaccard marked as the default
  assert.ok(/<code dir="ltr">jaccard<\/code> \(default\)/.test(lbHtml), "jaccard default row");
  assert.ok(/<code dir="ltr">hybrid<\/code>/.test(lbHtml) && lbHtml.includes("eliminated"), "hybrid row + elimination note");
  assert.ok(!/best skill|top skill|winning skill|ranked #1/i.test(lbHtml), "still no per-skill superiority claims");
});

test("S14: skill cards show jury sub-scores (Q/S/M) and evidence-titled security badges", () => {
  const out = mkSiteDir();
  build({ out, today: "2026-09-29" });
  const index = readFileSync(join(out, "skills", "index.html"), "utf8");
  assert.ok(/class="dims"[^>]*>Q <b>\d\.\d\d<\/b> · S <b>\d\.\d\d<\/b> · M <b>\d\.\d\d<\/b>/.test(index),
    "card dims line with numeric Q/S/M");
  assert.ok(index.includes('title="Rule-based security scan: verified'), "security badge tooltip carries scan evidence");
  assert.ok(index.includes('title="Jury sub-scores (3-model medians, 0–1)'), "dims tooltip documents the jury");
  const firstId = JSON.parse(readFileSync(join(out, "assets", "data", "skills.json"), "utf8")).skills[0].id;
  const detail = readFileSync(join(out, "skills", firstId, "index.html"), "utf8");
  assert.ok(detail.includes('title="Rule-based security scan:'), "detail page badge carries the scan tooltip");
  for (const dim of ["quality", "specificity", "maintenance"]) {
    assert.ok(detail.includes(`<span>${dim}</span>`), `detail jury bar: ${dim}`);
  }
});

test("S14: emptyState is escaped, id-able, hidden by default; drives the no-results state", () => {
  const h = emptyState({ id: "x", title: "<b>t</b>", body: "a & b", action: '<a href="/y">go</a>' });
  assert.ok(h.includes("&lt;b&gt;t&lt;/b&gt;"), "title escaped");
  assert.ok(h.includes("a &amp; b"), "body escaped");
  assert.ok(h.includes('id="x"') && /\bhidden\b/.test(h), "id + hidden default");
  assert.ok(h.includes('<a href="/y">go</a>'), "action markup passes through");
  assert.throws(() => emptyState({}), /title is required/);
  const out = mkSiteDir();
  build({ out, today: "2026-09-29" });
  const index = readFileSync(join(out, "skills", "index.html"), "utf8");
  assert.ok(index.includes('id="noresults"') && index.includes('class="empty"'),
    "skills index no-results uses the empty-state block");
});
