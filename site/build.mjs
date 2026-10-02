#!/usr/bin/env node
// Builds the Repotify website into site/dist: one static page per language (so search engines index each one),
// hreflang links, localized metadata and JSON-LD, sitemap.xml, robots.txt and a 404 page. Zero dependencies.
// Usage: node site/build.mjs [--out site/dist]
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildData } from "./build-data.mjs";
import { buildSubPages, slug } from "./build-sub.mjs";
export { slug };

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "src");
export const BASE_URL = "https://repotify.github.io/repotify/";
const BASE_PATH = new URL(BASE_URL).pathname;

// hreflang code, folder, text direction. English is the default and lives at the root.
export const LANGUAGES = [
  ["en", ""], ["zh-CN", "zh-cn"], ["zh-TW", "zh-tw"], ["ja", "ja"], ["ko", "ko"], ["es", "es"], ["pt-BR", "pt-br"],
  ["fr", "fr"], ["de", "de"], ["it", "it"], ["ru", "ru"], ["uk", "uk"], ["pl", "pl"], ["nl", "nl"], ["tr", "tr"],
  ["ar", "ar"], ["fa", "fa"], ["he", "he"], ["hi", "hi"], ["id", "id"], ["vi", "vi"], ["th", "th"], ["sv", "sv"], ["cs", "cs"],
].map(([code, dir]) => ({ code, dir, rtl: ["ar", "fa", "he"].includes(code) }));

export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Body text: escaped, with `code` marked up. Attributes and <title>: escaped, backticks dropped.
export const text = (s) => escapeHtml(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const attr = (s) => escapeHtml(String(s).replace(/`/g, ""));

const ICONS = {
  github: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  choice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M4 12h16M4 18h7"/><circle cx="18" cy="6" r="2"/><circle cx="15" cy="18" r="2"/></svg>',
  risk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4M12 17.2v.1" stroke-linecap="round"/></svg>',
  context: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h10M7 17h6"/></svg>',
  smart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5h10M9 12h10M9 19h10"/><path d="m3.5 5 1.5 1.5L7.5 4M3.5 12l1.5 1.5L7.5 11"/><path d="M4 18l3 3M7 18l-3 3"/></svg>',
  suggest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12 20 4l-4 16-4-7-8-1Z"/><path d="m12 13 8-9"/></svg>',
  keys: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/></svg>',
};

// The logo inline, with gradient ids unique per copy (it appears three times on each page).
function logo(suffix) {
  return readFileSync(join(SRC, "assets", "logo.svg"), "utf8")
    .replace(/<svg /, '<svg aria-hidden="true" focusable="false" ')
    .replace(/ role="img" aria-label="[^"]*"/, "")
    .replace(/ width="512" height="512"/, "")
    .replace(/id="(\w+)"/g, `id="$1-${suffix}"`)
    .replace(/url\(#(\w+)\)/g, `url(#$1-${suffix})`);
}

const pageUrl = (l) => BASE_URL + (l.dir ? `${l.dir}/` : "");
const relative = (from, to) => (from.dir ? "../" : "./") + (to.dir ? `${to.dir}/` : "");

function jsonLd(s, l, version) {
  const faq = [1, 2, 3, 4, 5, 6].map((i) => ({
    "@type": "Question",
    name: s[`faq_${i}_q`].replace(/`/g, ""),
    acceptedAnswer: { "@type": "Answer", text: s[`faq_${i}_a`].replace(/`/g, "") },
  }));
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Repotify",
      description: s.meta_description,
      url: pageUrl(l),
      inLanguage: l.code,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Linux, macOS, Windows (Node.js 18+)",
      softwareVersion: version,
      license: "https://opensource.org/licenses/MIT",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      downloadUrl: "https://www.npmjs.com/package/@repotify/repotify",
      codeRepository: "https://github.com/repotify/repotify",
      image: `${BASE_URL}assets/og.png`,
    },
    { "@context": "https://schema.org", "@type": "FAQPage", inLanguage: l.code, mainEntity: faq },
  ];
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function renderPage(template, strings, l, { version, langs = LANGUAGES, all = {}, skillCount = null }) {
  const computed = {
    lang: l.code,
    dir: l.rtl ? "rtl" : "ltr",
    root: l.dir ? "../" : "./",
    home: "./",
    canonical: pageUrl(l),
    version,
    skill_count: skillCount == null ? "" : String(skillCount),
    // The slogan, as in the README banner: "thousands" are the skills out there, the catalog is what passed the gate.
    og_image_alt: "Repotify: thousands of agent skills, the right ones for your repo",
    og_image: `${BASE_URL}assets/og.png`,
    hreflang: [
      ...langs.map((x) => `<link rel="alternate" hreflang="${x.code}" href="${pageUrl(x)}">`),
      `<link rel="alternate" hreflang="x-default" href="${BASE_URL}">`,
    ].join("\n"),
    og_locale_alternates: langs.filter((x) => x !== l).map((x) => `<meta property="og:locale:alternate" content="${attr(all[x.code]?.og_locale ?? x.code)}">`).join("\n"),
    langmenu: langs.map((x) => `<li><a href="${relative(l, x)}" hreflang="${x.code}" lang="${x.code}"${x === l ? ' aria-current="page"' : ""}>${escapeHtml(all[x.code]?.lang_name ?? x.code)}</a></li>`).join(""),
    jsonld: jsonLd(strings, l, version),
    logo: "",
    github: ICONS.github,
    globe: ICONS.globe,
    icon_choice: ICONS.choice,
    icon_risk: ICONS.risk,
    icon_context: ICONS.context,
    icon_smart: ICONS.smart,
    icon_audit: ICONS.audit,
    icon_suggest: ICONS.suggest,
    icon_keys: ICONS.keys,
  };
  let logos = 0;
  return template.replace(/\{\{(attr:)?([a-z0-9_]+)\}\}/g, (_, isAttr, key) => {
    if (key === "logo") return logo(++logos);
    if (key in computed) return computed[key];
    if (!(key in strings)) throw new Error(`${l.code}: missing string "${key}"`);
    return isAttr ? attr(strings[key]) : text(strings[key]);
  });
}

function sitemap(langs, today, extraPaths = []) {
  const alternates = langs.map((x) => `    <xhtml:link rel="alternate" hreflang="${x.code}" href="${pageUrl(x)}"/>`).join("\n");
  const urls = langs.map((l) => `  <url>\n    <loc>${pageUrl(l)}</loc>\n    <lastmod>${today}</lastmod>\n${alternates}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}"/>\n  </url>`);
  // English-only v2 sub-pages (skills index/detail, leaderboard): no translations.
  for (const p of extraPaths) urls.push(`  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

const NOT_FOUND = (version) => `<!doctype html>
<html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found · Repotify</title><meta name="robots" content="noindex"><meta name="theme-color" content="#000000">
<link rel="icon" href="${BASE_PATH}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${BASE_PATH}assets/styles.css?v=${version}"></head>
<body><div class="bg" aria-hidden="true"><span class="grid"></span></div><main id="main"><section class="final" style="min-height:80vh;display:grid;place-content:center">
<div class="mark small" aria-hidden="true">${logo("nf")}</div>
<h2>404: no such page</h2><p>The page you asked for is not here.</p>
<p style="margin-top:28px"><a class="btn primary" href="${BASE_PATH}">Repotify home</a></p></section></main></body></html>
`;

export function build({ out = join(here, "dist"), today = new Date().toISOString().slice(0, 10) } = {}) {
  const version = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  const template = readFileSync(join(SRC, "template.html"), "utf8");
  const all = Object.fromEntries(LANGUAGES.map((l) => [l.code, JSON.parse(readFileSync(join(SRC, "i18n", `${l.code}.json`), "utf8"))]));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "assets"), { recursive: true });
  const data = buildData({ out, today });
  for (const l of LANGUAGES) {
    const dir = join(out, l.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), renderPage(template, all[l.code], l, { version, all, skillCount: data.skillCount }));
  }
  for (const f of readdirSync(join(SRC, "assets"))) copyFileSync(join(SRC, "assets", f), join(out, "assets", f));
  copyFileSync(join(SRC, "styles.css"), join(out, "assets", "styles.css"));
  copyFileSync(join(SRC, "sub.css"), join(out, "assets", "sub.css"));
  copyFileSync(join(SRC, "app.js"), join(out, "assets", "app.js"));
  copyFileSync(join(SRC, "comments.js"), join(out, "assets", "comments.js"));
  const sub = buildSubPages({ out, version, today });
  writeFileSync(join(out, "sitemap.xml"), sitemap(LANGUAGES, today,
    ["skills/", "leaderboard/", ...sub.ids.map((id) => `skills/${id}/`)]));
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${BASE_URL}sitemap.xml\n`);
  writeFileSync(join(out, "404.html"), NOT_FOUND(version));
  writeFileSync(join(out, ".nojekyll"), "");
  return { out, pages: LANGUAGES.length + sub.pages, version, skills: sub.skills };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const r = build(i > 0 ? { out: resolve(process.argv[i + 1]) } : {});
  console.log(`site ${r.version}: ${r.pages} pages → ${r.out}`);
}
