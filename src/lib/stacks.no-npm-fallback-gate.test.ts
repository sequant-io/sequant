/**
 * Gate test (#932 AC-3): no producer reintroduces the literal fallback that
 * used to short-circuit `resolvePackageManager`'s lockfile detection on every
 * pnpm/yarn/bun worktree provisioned by `run.ts` (a declared-manager default
 * of a valid PM_CONFIG key, in any of its spellings: `?? "npm"`, `|| 'npm'`,
 * `?? DEFAULT_PM`, ...).
 *
 * The banned pattern is assembled at runtime (not written as a source
 * literal here) so this gate file doesn't trip its own grep.
 */

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SKILL_ROOTS } from "../../scripts/check-skill-sync.js";
import { skillEnv, skillFence } from "../../__tests__/helpers/skill-fence.js";
import { detectPackageManagerSync } from "./stacks.js";

// Extended-regex, assembled from parts: `packageManager` followed by a
// coalescing operator (`??` or `||`) OR a direct `:` assignment, and then the
// literal `"npm"` / `'npm'` or a `DEFAULT_PM`-style constant — every
// spelling of "assume npm" the original one-form grep would have missed (QA
// on PR #1000). Test files are excluded from the scan: fixtures legitimately
// declare `packageManager: "npm"` as data.
const BANNED_PATTERN = [
  "packageManager",
  "\\s*(\\?\\?|\\|\\||:)\\s*",
  "(\"npm\"|'npm'|DEFAULT_PM[A-Za-z_]*)",
].join("");

const SETUP_SKILL_MIRRORS = SKILL_ROOTS.map((root) => `${root}/setup/SKILL.md`);

describe("#932: packageManager literal npm fallback gate", () => {
  it('932: no source file falls back to a literal "npm" for an undeclared packageManager', () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        [
          "-rnE",
          "--exclude=*.test.ts",
          "--exclude=*.spec.ts",
          "--exclude-dir=__tests__",
          BANNED_PATTERN,
          "src",
          "bin",
        ],
        {
          encoding: "utf-8",
        },
      );
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
      // Scoped to the manifest template itself (CLAUDE.md: match the region
      // the assertion means to check, not the whole file — #830 class).
      const template = text.match(
        /create `\.sequant-manifest\.json`[\s\S]*?```jsonc?\n([\s\S]*?)```/,
      )?.[1];
      expect(
        template,
        `${SETUP_SKILL_MIRRORS[i]} should have a .sequant-manifest.json template block`,
      ).toBeDefined();
      expect(
        template,
        `${SETUP_SKILL_MIRRORS[i]} manifest template should write packageManager next to pmRun`,
      ).toMatch(/"pmRun":[\s\S]*"packageManager":/);
    }

    // I-4: the three mirrors must stay byte-identical.
    expect(contents[1]).toBe(contents[0]);
    expect(contents[2]).toBe(contents[0]);
  });
});

describe("#932: setup skill's lockfile detection picks what the resolver picks", () => {
  // Runs the skill's own "### 5. Detect Package Manager" fence (#1512) in a
  // temp dir seeded with every combination of JS lockfiles, and compares its
  // $PM to detectPackageManagerSync on the same dir. A reorder on either side
  // disagrees on some combination.
  const LOCKFILES = [
    "bun.lockb",
    "bun.lock",
    "yarn.lock",
    "pnpm-lock.yaml",
    "package-lock.json",
  ];
  const combos = Array.from({ length: 2 ** LOCKFILES.length }, (_, mask) =>
    LOCKFILES.filter((_f, i) => mask & (1 << i)),
  );
  const fence = skillFence("setup", {
    section: "### 5. Detect Package Manager",
    contains: "lock",
  });

  it.each(combos.map((files) => [files.join(" + ") || "(none)", files]))(
    "%s",
    (_label, files) => {
      const dir = mkdtempSync(join(tmpdir(), "sequant-pm-"));
      try {
        for (const f of files as string[]) writeFileSync(join(dir, f), "");
        const result = spawnSync(
          "bash",
          ["-c", `${fence}\nprintf '\\n%s' "$PM"`],
          {
            cwd: dir,
            encoding: "utf-8",
            env: skillEnv(),
          },
        );
        expect(result.status, result.stderr).toBe(0);
        // No lockfile: the skill leaves PM undeclared (#932), where the
        // resolver's own last resort is npm.
        const expected = files.length ? detectPackageManagerSync(dir) : "";
        expect(result.stdout.split("\n").pop()).toBe(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
