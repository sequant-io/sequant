// Issue #738 — AC-2/AC-3/AC-4: the three skill-mirror roots stay reconciled.
// Run with: npx vitest run __tests__/integration/skill-sync.integration.test.ts
//
// This guards the reconciliation that #738 performed and mirrors the CI gate
// (`npm run lint:skill-sync`): the whole repo must report 0 diverged / 0 missing
// and the checker must exit 0. If any skill file diverges across
// .claude/skills/, templates/skills/, and skills/, this fails — the same signal
// CI will surface on a PR.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("AC-4: whole-repo skill-mirror sync", () => {
  const run = () => {
    try {
      const stdout = execFileSync(
        "npx",
        ["tsx", "scripts/check-skill-sync.ts"],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return { stdout, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout || "", code: e.status ?? 1 };
    }
  };

  it("reports 0 diverged and 0 missing", () => {
    const { stdout } = run();
    expect(
      /Summary: \d+ synced, 0 diverged, 0 missing/.test(stdout),
      `Expected 0 diverged / 0 missing, got:\n${stdout}`,
    ).toBe(true);
  });

  it("exits 0 (clean) so the CI gate passes", () => {
    const { code, stdout } = run();
    expect(code, `Expected exit 0, got ${code}:\n${stdout}`).toBe(0);
  });
});
