// SKILL.md frontmatter, shared by the CLI (audit) and the catalog pipeline.

function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// Minimal YAML frontmatter reader: top-level string scalars only (plain, quoted, folded, literal, multi-line).
export function parseFrontmatter(text) {
  const src = String(text).replace(/^\u{FEFF}/u, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(src);
  if (!m) return {};
  const lines = m[1].split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const raw = (kv[2] ?? "").trim();
    const block = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i]);
    while (block.length && block[block.length - 1].trim() === "") block.pop();
    if (raw === "") {
      // Either a nested map (skipped) or a multi-line plain scalar.
      if (block.length && !/^\s+[A-Za-z_][\w-]*:(\s|$)/.test(block[0])) out[key] = block.map((l) => l.trim()).join(" ").trim();
      continue;
    }
    if (/^[>|][+-]?$/.test(raw)) {
      const trimmed = block.map((l) => l.trim());
      out[key] = raw.startsWith(">") ? trimmed.join(" ").replace(/\s+/g, " ").trim() : trimmed.join("\n");
      continue;
    }
    out[key] = unquote(block.length ? [raw, ...block.map((l) => l.trim())].join(" ") : raw);
  }
  return out;
}
