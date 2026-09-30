// Printing names that come from the file system or from project files: folder names, lock-file keys, license fields.
// A cloned repository controls them, so they are shown in a form that can neither steer a terminal nor pass as shell
// syntax when an agent or a person copies a suggested command.
import { escapeInvisible } from "./scan/index.mjs";

const PLAIN = /^[\w.@+\-/]+$/;

// Plain names as they are; anything else single-quoted for a POSIX shell, with control (C0 and C1), invisible and bidi
// characters escaped, so the quoted form never silently matches a name that relies on them.
export function shownName(value) {
  const s = String(value);
  if (PLAIN.test(s)) return s;
  const visible = escapeInvisible(s).replace(/[\u007f-\u009f]/g, (c) => `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}`);
  return `'${visible.replace(/'/g, "'\\''")}'`;
}
