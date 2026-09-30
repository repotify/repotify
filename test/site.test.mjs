import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, renderPage, LANGUAGES, BASE_URL } from "../site/build.mjs";

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
  const out = mkdtempSync(join(tmpdir(), "repotify-site-"));
  const r = build({ out, today: "2026-09-29" });
  assert.equal(r.pages, LANGUAGES.length);
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
  for (const f of ["styles.css", "app.js", "og.png", "favicon.svg", "apple-touch-icon.png", "jetbrains-mono-latin.woff2", "jetbrains-mono-OFL.txt"]) {
    assert.ok(existsSync(join(out, "assets", f)), f);
  }
  const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
  assert.equal((sitemap.match(/<url>/g) ?? []).length, LANGUAGES.length);
  assert.equal((sitemap.match(/<xhtml:link /g) ?? []).length, LANGUAGES.length * (LANGUAGES.length + 1));
  assert.match(readFileSync(join(out, "robots.txt"), "utf8"), /Sitemap: https:\/\/repotify\.github\.io\/repotify\/sitemap\.xml/);
  assert.ok(existsSync(join(out, "404.html")));
});

test("strings are escaped, `code` becomes <code>, and a missing string fails the build", () => {
  const l = LANGUAGES[0];
  const html = renderPage("<p>{{a}}</p><i title=\"{{attr:a}}\"></i>", { ...en, a: 'Run `x` <script>"' }, l, { version: "9.9.9", all: { en } });
  assert.equal(html, '<p>Run <code>x</code> &lt;script&gt;&quot;</p><i title="Run x &lt;script&gt;&quot;"></i>');
  assert.throws(() => renderPage("{{nope}}", en, l, { version: "9.9.9", all: { en } }), /missing string "nope"/);
});
