/**
 * Gate test for #1287: no skill pre-approves broad shell access.
 *
 * While a skill is active, each `allowed-tools` entry in its frontmatter lets
 * Claude Code run matching commands without asking. The plugin directory holds
 * a plugin for review when an entry is bare `Bash`, `Bash(*)`, or a wildcard
 * directly after a shell, interpreter, package manager or runner. This gate
 * rejects those forms in every skill of every mirrored root:
 *
 * - AC-1: bare `Bash`, `Bash(*)`, and `Bash(<tool> *)` / `Bash(<tool>:*)` for
 *   gh, git, npm, npm run, npx and the other runners in BROAD_TOOLS.
 * - AC-2: an entry that starts with a runner (`npx`, `node -e`,
 *   `npm install`, …) and ends in `*` — unless RUNNER_ALLOWLIST names it with
 *   a reason.
 * - AC-3: an unrendered `{{…}}` placeholder. `plugin/skills/` is copied
 *   without placeholder rendering, so such an entry never matches anything.
 *
 * Scoped to the frontmatter block (between the first two `---` lines) — the
 * skill bodies legitimately mention `Bash` and `{{PM_RUN}}`. Each case walks
 * the root with `collectFiles` (the skill-sync guard's own walker), so a
 * skill added to only one root is still checked.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  collectFiles,
  SKILL_ROOTS,
} from "../../../scripts/check-skill-sync.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");

/** A wildcard straight after one of these grants (nearly) any command. */
const BROAD_TOOLS = [
  "gh",
  "git",
  "npm",
  "npm run",
  "npx",
  "node",
  "tsx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "bash",
  "sh",
  "zsh",
  "python",
  "python3",
  "uv",
  "deno",
  "curl",
  "wget",
];

/** Entries starting with one of these run code the entry cannot pin down. */
const RUNNER_PREFIXES = [
  "npx ",
  "node ",
  "tsx ",
  "npm install",
  "npm ci",
  "npm exec",
  "npm x ",
  "pnpm dlx",
  "pnpm exec",
  "yarn dlx",
  "bunx ",
  "bash ",
  "sh ",
  "python",
  "uv run",
];

/**
 * Runner entries that end in `*` but are kept: each runs one fixed
 * subcommand, and the wildcard covers only its arguments.
 */
const RUNNER_ALLOWLIST: Record<string, string> = {
  "npx sequant worktree resolve *":
    "read-only lookup; the wildcard is the issue number",
  "npx sequant worktree verify *":
    "read-only check; the wildcard is the path and --issue number",
};

/** Frontmatter `---` block. Throws so a malformed file fails loudly. */
function frontmatter(text: string, file: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error(`${file}: no opening ---`);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(`${file}: no closing ---`);
  return lines.slice(1, end).join("\n");
}

/** The `allowed-tools` list items, with trailing `# comments` stripped. */
function allowedTools(fm: string): string[] {
  const lines = fm.split("\n");
  const start = lines.findIndex((l) => l.startsWith("allowed-tools:"));
  if (start === -1) return [];
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith("- ")) break;
    entries.push(
      trimmed
        .slice(2)
        .replace(/\s+#.*$/, "")
        .trim(),
    );
  }
  return entries;
}

/** Why an entry is too broad, or null. `X:*` is read as `X *`. */
function violation(entry: string): string | null {
  if (entry.includes("{{")) return "unrendered placeholder (AC-3)";
  if (entry === "Bash") return "bare Bash (AC-1)";
  const m = entry.match(/^Bash\((.*)\)$/);
  if (!m) return null;
  const cmd = m[1].trim().replace(/:\*$/, " *");
  if (cmd === "*") return "Bash(*) (AC-1)";
  if (BROAD_TOOLS.some((t) => cmd === `${t} *`)) {
    return "wildcard directly after the tool (AC-1)";
  }
  // A global option before the subcommand (`git -C <path>`, `gh -R <repo>`)
  // leaves the subcommand to the wildcard: `git -C *` is `git *`.
  if (/^(git -[Cc]|gh (-R|--repo)) /.test(cmd) && cmd.endsWith("*")) {
    return "wildcard after a global option, before the subcommand (AC-1)";
  }
  // The portal reads `npm --version:*` as any npm command: a flag first
  // leaves the subcommand to the wildcard.
  if (
    /^(npm|yarn|pnpm|bun|bunx|node|python3?|pip3?|uv|deno) -/.test(cmd) &&
    cmd.endsWith("*")
  ) {
    return "package-manager or runner flag followed by a wildcard (AC-2)";
  }
  // A relative path names whatever file sits there in the current folder,
  // not a file the plugin ships.
  if (/^\.\.?\//.test(cmd) && cmd.endsWith("*")) {
    return "relative-path script with a wildcard (AC-2)";
  }
  if (
    RUNNER_PREFIXES.some((p) => cmd.startsWith(p)) &&
    cmd.endsWith("*") &&
    !(cmd in RUNNER_ALLOWLIST)
  ) {
    return "runner wildcard not in RUNNER_ALLOWLIST (AC-2)";
  }
  return null;
}

/** Top-level `<skill>/SKILL.md` paths under one root. */
function skillFiles(root: string): string[] {
  return collectFiles(join(REPO_ROOT, root)).filter(
    (f) => f.split("/").length === 2 && f.endsWith("/SKILL.md"),
  );
}

function grants(root: string, file: string): string[] {
  const text = readFileSync(join(REPO_ROOT, root, file), "utf8");
  return allowedTools(frontmatter(text, `${root}/${file}`));
}

describe("skill allowed-tools grant no broad shell access (#1287)", () => {
  it.each(SKILL_ROOTS)("%s — every skill is parsed", (root) => {
    // Guards against a vacuous pass: an empty glob or a parser that stops
    // reading the list would leave nothing for the policy case to reject.
    const files = skillFiles(root);
    expect(files).toEqual(skillFiles(".claude/skills"));
    expect(files.length).toBeGreaterThanOrEqual(15);
    const total = files.reduce((n, f) => n + grants(root, f).length, 0);
    expect(total).toBeGreaterThanOrEqual(100);
  });

  it.each(SKILL_ROOTS)(
    "%s — no bare Bash, Bash(*), tool or runner wildcard, or placeholder",
    (root) => {
      const found = skillFiles(root).flatMap((f) =>
        grants(root, f)
          .map((e) => [e, violation(e)] as const)
          .filter(([, why]) => why !== null)
          .map(([e, why]) => `${f}: ${e} — ${why}`),
      );
      expect(found).toEqual([]);
    },
  );
});
