import { scanFiles, levelFromFindings, SCANNER_VERSION } from "../src/scan/index.mjs";

// Bump whenever gate rules change; the test suite refuses a bundled catalog gated by an older version.
export const GATE_VERSION = "2";

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];

export function parseNpmSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "latest" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

const unverified = (what, why) => ({
  rule: "install-script", severity: "medium", file: "(package)", line: 0, excerpt: what, note: `could not verify package: ${why}`,
});

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
export async function packageFindings({ npm, pypi } = {}, { fetchImpl = fetch } = {}) {
  const findings = [];
  if (npm) {
    const { name, version } = parseNpmSpec(npm);
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`);
      if (!res.ok) findings.push(unverified(npm, `HTTP ${res.status}`));
      else {
        const doc = await res.json();
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
  if (setup?.mcp) lines.push([setup.mcp.command, ...(setup.mcp.args ?? [])].join(" "));
  return lines.join("\n") + "\n";
}

export async function setupSecurity(setup, { fetchImpl = fetch, now = new Date() } = {}) {
  const scan = scanFiles([{ path: "setup.sh", content: setupText(setup) }]);
  const findings = [...scan.findings, ...(await packageFindings(setup, { fetchImpl }))];
  return { level: levelFromFindings(findings), findings, scannedAt: now.toISOString(), scannerVersion: SCANNER_VERSION, gateVersion: GATE_VERSION };
}

export function securityRecord(scan, now = new Date()) {
  return { level: scan.level, findings: scan.findings, scannedAt: now.toISOString(), scannerVersion: SCANNER_VERSION, gateVersion: GATE_VERSION };
}
