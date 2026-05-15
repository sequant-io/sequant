/**
 * Drift guard for hooks (#645).
 *
 * PR #638 added relay support to `templates/hooks/` but never updated the
 * active hooks in `.claude/hooks/`. The installed `post-tool.sh` was
 * Mar-25-era and missed the SEQUANT_RELAY sourcing block, so the
 * PostToolUse chain never advanced the relay cursor. After the reconcile
 * in PR #649, every file present in `templates/hooks/` MUST be byte-identical
 * to its `.claude/hooks/` counterpart — there is no allowed divergence.
 *
 * `.claude/hooks/` MAY contain extra files that templates don't have (e.g.
 * `capture-tokens.sh`, which is sequant-specific and intentionally local).
 *
 * Run `npm run sync-hooks` to regenerate `.claude/hooks/` from the
 * templates after editing any template hook.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const TEMPLATES_DIR = "templates/hooks";
const ACTIVE_DIR = ".claude/hooks";

function listHookFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => fs.statSync(path.join(dir, n)).isFile())
    .sort();
}

describe("hook sync (#645)", () => {
  const templatesPath = path.join(process.cwd(), TEMPLATES_DIR);
  const activePath = path.join(process.cwd(), ACTIVE_DIR);

  it("every file in templates/hooks/ exists byte-identically in .claude/hooks/", () => {
    expect(fs.existsSync(templatesPath)).toBe(true);
    expect(fs.existsSync(activePath)).toBe(true);

    const templateFiles = listHookFiles(templatesPath);
    expect(templateFiles.length).toBeGreaterThan(0);

    const drift: string[] = [];
    for (const name of templateFiles) {
      const tBytes = fs.readFileSync(path.join(templatesPath, name));
      const aPath = path.join(activePath, name);
      if (!fs.existsSync(aPath)) {
        drift.push(`MISSING: .claude/hooks/${name}`);
        continue;
      }
      const aBytes = fs.readFileSync(aPath);
      if (!aBytes.equals(tBytes)) {
        drift.push(`DRIFT: .claude/hooks/${name}`);
      }
    }

    expect(drift).toEqual([]);
  });

  it(".claude/hooks/ may have extra local-only files (e.g. capture-tokens.sh)", () => {
    // This is documentation-as-test: we intentionally allow `.claude/hooks/`
    // to contain files that aren't in templates. If we ever decide that's
    // wrong, flip this test to enforce parity in both directions.
    const templateFiles = new Set(listHookFiles(templatesPath));
    const activeFiles = listHookFiles(activePath);
    const extras = activeFiles.filter((n) => !templateFiles.has(n));
    // Just assert the contract; don't fail on extras.
    expect(extras.every((n) => typeof n === "string")).toBe(true);
  });

  it("post-tool.sh sources relay-check.sh under SEQUANT_RELAY (kept for clarity)", () => {
    // Redundant with the byte-equality check above, but kept so a failure
    // here points directly at the relay regression rather than a generic
    // "files differ" message.
    const content = fs.readFileSync(
      path.join(activePath, "post-tool.sh"),
      "utf-8",
    );
    expect(content).toMatch(/SEQUANT_RELAY:-/);
    expect(content).toMatch(/source\s+"?\$\{?_RELAY_CHECK\}?"?/);
  });
});
