import { scanFiles, levelFromFindings, SCANNER_VERSION } from "../src/scan/index.mjs";
import { commandLines, envLines, riskyEnvNames } from "../src/mcpconfig.mjs";
import { NEW_PACKAGE_DAYS } from "../src/guard.mjs";

// Bump whenever gate rules change; the test suite refuses a bundled catalog gated by an older version.
// 3: a package that could not be verified is no longer publishable; brand-new packages and an MCP server's
//    environment are findings.
export const GATE_VERSION = "3";
const DAY = 86400000;

// The scripts npm runs when a published package is installed from the registry. `prepare` is not one of them: it
// runs when the package is packed or installed from git, on its author's machine or a git dependency's, never when
// `npx pkg@version` fetches the tarball (most packages have one for their own build).
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

export function parseNpmSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "latest" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

// The registry or the vulnerability database did not answer for this package. That is not a verdict on it, so it is
// not publishable either: as a caution it went into the catalog exactly when the check that could reject it was down.
const unverified = (what, why) => ({
  rule: "install-script", severity: "high", file: "(package)", line: 0, excerpt: what, note: `could not verify package: ${why}`,
});
export const isUnverified = (findings) => (findings ?? []).some((f) => String(f.note ?? "").startsWith("could not verify"));

// A package first published days ago has no history to judge it by: no advisory, no users, and that is what every
// fresh malicious package looks like. The guard asks about these on the user's machine; the gate marks them too.
const tooNew = (what, days) => ({
  rule: "new-package", severity: "medium", file: "(package)", line: 0, excerpt: what, note: `first published ${days} day${days === 1 ? "" : "s"} ago`,
});
const ageDays = (created, now) => (created ? Math.floor((now - new Date(created)) / DAY) : null);

const OSV_SEVERITY = { CRITICAL: "high", HIGH: "high", MODERATE: "medium", MEDIUM: "medium", LOW: "low" };

// Known vulnerabilities of an exact pinned version (OSV aggregates GitHub advisories, PyPA and more).
// A vulnerable version is not malicious, so the worst outcome is quarantine (review), not rejection.
export async function osvFindings(ecosystem, name, version, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: { name, ecosystem }, version }),
    });
    if (!res.ok) return [unverified(`${name}@${version}`, `OSV HTTP ${res.status}`)];
    const doc = await res.json();
    return (doc.vulns ?? []).slice(0, 10).map((v) => {
      const level = String(v.database_specific?.severity ?? "").toUpperCase();
      return {
        rule: "known-vulnerability",
        severity: OSV_SEVERITY[level] ?? "medium",
        file: "(package)",
        line: 0,
        excerpt: `${v.id}: ${String(v.summary ?? "").slice(0, 60)}`,
        note: `${name}@${version} ${level || "unrated"}`,
      };
    });
  } catch (error) {
    return [unverified(`${name}@${version}`, `OSV ${error.message}`)];
  }
}

// Registry checks for tool/MCP items that are installed from npm or PyPI.
export async function packageFindings({ npm, pypi } = {}, { fetchImpl = fetch, now = new Date() } = {}) {
  const findings = [];
  if (npm) {
    const { name, version } = parseNpmSpec(npm);
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`);
      if (!res.ok) findings.push(unverified(npm, `HTTP ${res.status}`));
      else {
        const doc = await res.json();
        // The package's own age comes from the full document (`time.created`); the version document has no dates.
        const all = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
        if (!all.ok) findings.push(unverified(npm, `HTTP ${all.status} for its history`));
        else {
          // npm and PyPI always give the date; a registry that does not leaves the age unknown, which is not "new".
          const days = ageDays((await all.json())?.time?.created, now);
          if (days !== null && days < NEW_PACKAGE_DAYS) findings.push(tooNew(npm, days));
        }
        const hooks = INSTALL_HOOKS.filter((k) => doc.scripts && k in doc.scripts);
        if (hooks.length) {
          findings.push({
            rule: "install-script", severity: "medium", file: "(package)", line: 0,
            excerpt: hooks.map((k) => `${k}: ${doc.scripts[k]}`).join("; ").slice(0, 80), note: `${npm} runs code at install time`,
          });
        }
      }
    } catch (error) {
      findings.push(unverified(npm, error.message));
    }
    findings.push(...(await osvFindings("npm", name, version, { fetchImpl })));
  }
  if (pypi) {
    const [name, version] = pypi.split("==");
    try {
      const res = await fetchImpl(`https://pypi.org/pypi/${name}/${version}/json`);
      if (!res.ok) findings.push(unverified(pypi, `HTTP ${res.status}`));
      else {
        const all = await fetchImpl(`https://pypi.org/pypi/${name}/json`);
        if (!all.ok) findings.push(unverified(pypi, `HTTP ${all.status} for its history`));
        else {
          const times = Object.values((await all.json())?.releases ?? {}).flat().map((f) => f.upload_time_iso_8601).filter(Boolean).sort();
          const days = ageDays(times[0], now);
          if (days !== null && days < NEW_PACKAGE_DAYS) findings.push(tooNew(pypi, days));
        }
      }
    } catch (error) {
      findings.push(unverified(pypi, error.message));
    }
    findings.push(...(await osvFindings("PyPI", name, version, { fetchImpl })));
  }
  return findings;
}

export function setupText(setup) {
  const lines = [...(setup?.steps ?? [])];
  if (setup?.verify) lines.push(setup.verify);
  if (setup?.mcp) lines.push(...commandLines(setup.mcp.command, setup.mcp.args ?? []), ...envLines(setup.mcp.env));
  return lines.join("\n") + "\n";
}

// An MCP entry's environment is part of its command: a variable that points the package manager at another registry
// or makes the interpreter load a file first decides what runs, with nothing suspicious on the command line.
export function envFindings(setup) {
  return riskyEnvNames(setup?.mcp?.env).map((name) => ({
    rule: "risky-env", severity: "high", file: "(setup)", line: 0, excerpt: String(name).slice(0, 80), note: "changes what is installed, loaded or where traffic goes",
  }));
}

export async function setupSecurity(setup, { fetchImpl = fetch, now = new Date() } = {}) {
  const scan = scanFiles([{ path: "setup.sh", content: setupText(setup) }]);
  const findings = [...scan.findings, ...envFindings(setup), ...(await packageFindings(setup, { fetchImpl, now }))];
  return { level: levelFromFindings(findings), findings, scannedAt: now.toISOString(), scannerVersion: SCANNER_VERSION, gateVersion: GATE_VERSION };
}

export function securityRecord(scan, now = new Date()) {
  return { level: scan.level, findings: scan.findings, scannedAt: now.toISOString(), scannerVersion: SCANNER_VERSION, gateVersion: GATE_VERSION };
}
