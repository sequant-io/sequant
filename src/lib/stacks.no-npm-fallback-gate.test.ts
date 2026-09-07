/**
 * Gate test (#932 AC-3): no producer reintroduces the literal fallback that
 * used to short-circuit `resolvePackageManager`'s lockfile detection on every
 * pnpm/yarn/bun worktree provisioned by `run.ts` (a declared-manager default
 * of a valid PM_CONFIG key, spelled with the nullish-coalescing operator).
 *
 * The banned pattern is assembled at runtime (not written as a source
 * literal here) so this gate file doesn't trip its own grep.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const BANNED_PATTERN = ["packageManager", "??", '"npm"'].join(" ");

const SETUP_SKILL_MIRRORS = [
  "templates/skills/setup/SKILL.md",
  ".claude/skills/setup/SKILL.md",
  "skills/setup/SKILL.md",
];

describe("#932: packageManager literal npm fallback gate", () => {
  it('932: no source file falls back to a literal "npm" for an undeclared packageManager', () => {
    let output = "";
    try {
      output = execFileSync("grep", ["-rn", BANNED_PATTERN, "src", "bin"], {
        encoding: "utf-8",
      });
    } catch (err) {
      // grep exits 1 when there are no matches — that's the passing case.
      const execErr = err as { status?: number; stdout?: string };
      if (execErr.status === 1) {
        output = "";
      } else {
        throw err;
      }
    }

    expect(output.trim()).toBe("");
  });

  it("932: setup skill's manifest template writes packageManager next to pmRun, in all 3 mirrors", () => {
    const contents = SETUP_SKILL_MIRRORS.map((path) =>
      readFileSync(path, "utf-8"),
    );

    for (const [i, text] of contents.entries()) {
      expect(
        text,
        `${SETUP_SKILL_MIRRORS[i]} should mention packageManager`,
      ).toContain("packageManager");
    }

    // I-4: the three mirrors must stay byte-identical.
    expect(contents[1]).toBe(contents[0]);
    expect(contents[2]).toBe(contents[0]);
  });
});
