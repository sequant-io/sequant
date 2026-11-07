/**
 * A prose gate is a test that reads a `SKILL.md` and asserts on its text
 * (#1566). Mentioning the name in a comment, a fixture path or a message
 * string does not count. Shared by the health report's `proseGate` metric
 * and the Read-first comment's `prose` seam class (#1520), so both surfaces
 * count the same files.
 */
export function isProseGate(text: string): boolean {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  if (!/toContain|toMatch/.test(code)) return false;
  // SKILL_ROOTS outside imports and string literals: a mention in a string is not a read.
  const bare = code
    .replace(/^import[^;]*;/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  if (/\bSKILL_ROOTS\b/.test(bare)) return true;
  // Variables assigned from an expression naming SKILL.md may be the read's path argument.
  // A bare relative literal (`const P = ".claude/skills/x/SKILL.md"`) names a file the test
  // writes into a scratch directory, not a shipped skill.
  const pathVars = [
    ...code.matchAll(/\b(?:const|let|var)\s+(\w+)\b[^;]*?=([^;]*SKILL\.md[^;]*);/g),
  ]
    .filter((m) => !/^\s*(["'`])[^"'`]*\1\s*$/.test(m[2]))
    .map((m) => m[1]);
  const pathArg = new RegExp(["SKILL\\.md", ...pathVars.map((v) => `\\b${v}\\b`)].join("|"));
  return [...code.matchAll(/\b\w*[Rr]ead\w*\s*\(([^;]*)/g)].some((m) => pathArg.test(m[1]));
}
