// Issue #552 — AC-4: 3-dir sync for behavior-rule files
// Run with: npx vitest run __tests__/integration/behavior-rule-skill-sync.integration.test.ts
//
// The AC requires `npx tsx scripts/check-skill-sync.ts` to report `synced 3/3`
// for spec/SKILL.md, qa/SKILL.md, and the new reference doc. We assert on the
// touched files directly (not the whole repo) since unrelated pre-existing
// divergence is out of scope for this issue.
//
// #1265 added plugin/skills as a 4th mirror, so the script's own "N/N match"
// denominator grew from 3 to 4 (scripts/check-skill-sync.ts's MIRROR_DIRS).
// The "3-dir" framing in this file's name and prose describes the original
// #552 scope and is left as historical context; only the numeric assertion
// below follows the script's real output.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SKILL_ROOTS } from "../../scripts/check-skill-sync.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
/** check-skill-sync.ts reports "N/N match" over the source plus every mirror. */
const ROOT_COUNT = SKILL_ROOTS.length;

const TOUCHED_FILES = [
  "spec/SKILL.md",
  "qa/SKILL.md",
  "_shared/references/behavior-rule-detection.md",
];

describe("AC-4: skill-sync 3-dir mirror for behavior-rule files", () => {
  describe("happy path: all 3 mirrors of touched files exist", () => {
    for (const rel of TOUCHED_FILES) {
      it(`exists in all 3 mirror dirs: ${rel}`, () => {
        for (const root of SKILL_ROOTS) {
          const full = path.join(REPO_ROOT, root, rel);
          expect(fs.existsSync(full), `Missing: ${full}`).toBe(true);
        }
      });
    }
  });

  describe("scripts/check-skill-sync.ts reports synced 3/3 for touched files", () => {
    // Run the sync script once and assert per-file. The script reports per-file
    // status like: `  synced  spec/SKILL.md — 3/3 match`. We grep for that
    // exact "synced  <file>" prefix on each touched file. Note the script may
    // exit non-zero due to *unrelated* pre-existing divergence; we capture
    // stdout regardless and assert only on our files.
    const output = (() => {
      try {
        return execSync("npx tsx scripts/check-skill-sync.ts", {
          cwd: REPO_ROOT,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (err) {
        const e = err as { stdout?: string };
        return e.stdout || "";
      }
    })();

    for (const rel of TOUCHED_FILES) {
      it(`reports synced ${ROOT_COUNT}/${ROOT_COUNT} for ${rel}`, () => {
        const escaped = rel.replace(/[/.]/g, (m) => "\\" + m);
        const syncedRe = new RegExp(
          `synced\\s+${escaped}\\s+—\\s+${ROOT_COUNT}\\/${ROOT_COUNT} match`,
        );
        expect(
          syncedRe.test(output),
          `Expected '${rel}' synced ${ROOT_COUNT}/${ROOT_COUNT}, got:\n${output}`,
        ).toBe(true);
        // And explicitly NOT diverged or missing for our files.
        const divergedRe = new RegExp(`DIVERGED\\s+${escaped}`);
        const missingRe = new RegExp(`missing\\s+${escaped}`);
        expect(divergedRe.test(output)).toBe(false);
        expect(missingRe.test(output)).toBe(false);
      });
    }
  });
});
