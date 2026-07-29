/**
 * QA Precheck CLI — integration tests (shell out to the real CLI).
 *
 * Split from `precheck.test.ts` (#842): that file has no `.integration.` infix,
 * so it runs in the `unit` project — 5 s testTimeout, `fileParallelism` ON —
 * while these two tests spawn `npx tsx` (4.2 s idle on a cold cache,
 * 7.5-17.8 s under load). The initial #842 fix gave the describe a 90 s
 * ceiling, but that only raised the number the CPU contention collides with;
 * the cause is project membership. The `.integration.` name puts this file
 * where subprocess spawns are serialized (`fileParallelism: false`) and the
 * 30 s project floor applies. The 90 s ceiling is kept because it must sit
 * strictly above the 60 s child timeout below (AC-3 ordering — the child kill
 * fires first and reports SIGTERM + captured output instead of vitest's
 * opaque timeout).
 *
 * The unit-testable surface (extractFixtures, extractACIDs, runPrecheck with
 * injected sources, parseArgs) stays in `precheck.test.ts` so those 28 tests
 * keep running in the parallel unit project.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "precheck.ts");
const REPO_ROOT = path.resolve(__dirname, "../..");

describe("precheck CLI (integration)", { timeout: 90_000 }, () => {
  it("--help prints usage and exits 0", () => {
    const out = execSync(`npx tsx ${CLI_PATH} --help`, {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      timeout: 30000,
    });
    expect(out).toContain("QA Precheck");
    expect(out).toContain("--issue");
    expect(out).toContain("--out");
  });

  it("--out writes a JSON file with the expected schema", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "precheck-"));
    const outPath = path.join(tmpDir, "precheck.json");
    try {
      execSync(`npx tsx ${CLI_PATH} --out ${outPath}`, {
        encoding: "utf-8",
        cwd: REPO_ROOT,
        timeout: 60000,
        // No --issue: precheck runs with null issue, gh fetch returns null,
        // and we still write a fail/not_applicable result.
      });
      const body = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      expect(body.schemaVersion).toBe(1);
      expect(body.checks).toHaveProperty("fixtures");
      expect(body.checks).toHaveProperty("siblingGrep");
      expect(body.checks).toHaveProperty("acLiteralDiff");
      expect(typeof body.generatedAt).toBe("string");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
