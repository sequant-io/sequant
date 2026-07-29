/**
 * Anti-drift guard for the worked examples in `skills/assess/SKILL.md` (AC-36).
 *
 * Regenerating the examples once is not enough — #823's root defect was that
 * hand-maintained examples drifted from each other over time and nothing
 * noticed. These tests make drift a build failure:
 *
 *  1. Every example with a known payload must appear in SKILL.md **byte for
 *     byte** as the renderer produces it.
 *  2. Every dashboard row in the file — including examples added later, whose
 *     payloads live nowhere — must sit at `RUN_COL`, and every separator must be
 *     exactly `SEPARATOR_WIDTH`.
 *
 * Rule 2 is the one that catches a future hand-edit, so it scans all three
 * mirrored skill directories rather than just the source of truth.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import stringWidth from "string-width";

import { GEOMETRY, render } from "./renderer.js";
import { parseAssessResult } from "./types.js";

const SKILL_DIRS = [
  "skills/assess/SKILL.md",
  ".claude/skills/assess/SKILL.md",
  "templates/skills/assess/SKILL.md",
];

const repoRoot = new URL("../../../", import.meta.url);

function readSkill(relativePath: string): string {
  return readFileSync(new URL(relativePath, repoRoot), "utf-8");
}

/**
 * The payloads behind every worked example in the skill. Adding an example to
 * SKILL.md means adding its payload here — that is the point.
 */
const EXAMPLES: Record<string, unknown> = {
  "Output Format — batch worked example": {
    mode: "batch",
    commandPrefix: "npx sequant",
    issues: [
      {
        number: 462,
        action: "PARK",
        reason: "Manual measurement task",
        run: "‖",
      },
      {
        number: 461,
        action: "PROCEED",
        reason: "Exact label matching",
        run: "spec → exec → qa",
        phases: ["spec", "exec", "qa"],
        qualityLoop: true,
      },
      {
        number: 412,
        action: "PROCEED",
        reason: "Auth bug (domain: auth adds security review phase)",
        run: "spec → security-review → exec → qa",
        phases: ["spec", "security-review", "exec", "qa"],
        qualityLoop: true,
      },
      {
        number: 411,
        action: "PROCEED",
        reason: "Config path normalization",
        run: "◂ exec → qa",
        phases: ["exec", "qa"],
        qualityLoop: true,
      },
      {
        number: 405,
        action: "REWRITE",
        reason: "PR #380 200+ commits behind",
        run: "⟳ spec → exec → qa",
        phases: ["spec", "exec", "qa"],
        qualityLoop: true,
      },
      { number: 447, action: "CLOSE", reason: "PR #457 merged", run: "—" },
    ],
    commands: [
      { args: "run 461 -Q" },
      { args: "run 412 -Q --security-review" },
      { args: "run 411 -Q --phases exec,qa", comment: "resume" },
      { args: "run 405 -Q", comment: "restart" },
    ],
    orders: [
      "460 → 461 (460 adds batch-executor tests that 461's label matching depends on)",
    ],
    warnings: [
      { issue: 405, text: "Stale 30+ days, ACs still valid" },
      {
        issue: 412,
        text: "bug + auth labels — auth (domain) adds security-review phase",
      },
    ],
    flags: [
      { flag: "-Q", reason: "multi-file scope across most PROCEED issues" },
      {
        flag: "--security-review",
        reason: "#412 auth label requires a security review",
      },
      {
        flag: "--phases exec,qa",
        reason: "#411 resume — prior spec marker already exists",
      },
    ],
    considered: [
      {
        flag: "--testgen",
        reason: "no ui/frontend labels or testable-AC signals in the batch",
      },
    ],
    cleanup: [
      { command: "gh issue close 447", reason: "PR #457 merged" },
      { command: "gh issue edit 461 --add-label cli", reason: "missing label" },
    ],
  },

  "Single Mode — PROCEED example": {
    mode: "single",
    commandPrefix: "npx sequant",
    issues: [
      {
        number: 458,
        action: "PROCEED",
        reason: "Both root causes confirmed in codebase",
        title: "Parallel run UX freeze + reconcileState race condition",
        state: "Open",
        labels: ["bug", "enhancement", "cli"],
        acCount: 8,
        phases: ["spec", "exec", "qa"],
        qualityLoop: true,
        command: { args: "run 458 -Q" },
        flags: [{ flag: "-Q", reason: "dual concern across 4 files" }],
        warnings: ["Dual concern (UX + race) across 4 files"],
      },
    ],
  },

  "Persist — dashboard excerpt for #458": {
    mode: "batch",
    commandPrefix: "npx sequant",
    issues: [
      {
        number: 458,
        action: "PROCEED",
        reason: "Parallel UX + race condition",
        run: "spec → exec → qa",
        phases: ["spec", "exec", "qa"],
        qualityLoop: true,
      },
    ],
    commands: [{ args: "run 458 -Q" }],
    warnings: [{ issue: 458, text: "Dual concern (UX + race) across 4 files" }],
    flags: [{ flag: "-Q", reason: "dual concern across 4 files" }],
  },

  "Persist — posted comment on #530 (PARK)": {
    mode: "single",
    commandPrefix: "npx sequant",
    issues: [
      {
        number: 530,
        action: "PARK",
        reason: "Blocked on manual measurement not yet scheduled",
        title: "Measure real-world assess latency across 20 repos",
        state: "Open",
        labels: ["task", "needs-data"],
        resumeAfter: "latency sampling run completes",
        warnings: [
          "Re-assessed 3 times since 2026-06-30 without execution — possible blocker or low priority",
        ],
      },
    ],
  },
};

describe("SKILL.md examples are renderer output (AC-36)", () => {
  const skill = readSkill(SKILL_DIRS[0]);

  for (const [label, payload] of Object.entries(EXAMPLES)) {
    it(`${label} matches the renderer byte for byte`, () => {
      const expected = render(parseAssessResult(payload));
      expect(
        skill.includes(expected),
        `SKILL.md no longer contains the rendered "${label}". ` +
          `Regenerate it from renderer output rather than hand-editing.\n\n` +
          `Expected block:\n${expected}`,
      ).toBe(true);
    });
  }
});

describe("SKILL.md geometry invariants hold in every mirror", () => {
  for (const path of SKILL_DIRS) {
    describe(path, () => {
      const skill = readSkill(path);

      it("starts every dashboard Run value at RUN_COL", () => {
        const misaligned: string[] = [];
        let checked = 0;

        for (const line of skill.split("\n")) {
          // Dashboard header or data row: leading space, then `#`/digits,
          // then a gap and an uppercase Action or column label.
          if (!/^ (#|\d+) {2,}[A-Z]/.test(line)) continue;
          const run = line.match(/(Run$|spec |exec |qa$|◂ |⟳ |‖|—$|\? )/);
          if (!run) continue;

          checked += 1;
          const offset = stringWidth(line.slice(0, run.index));
          if (offset !== GEOMETRY.RUN_COL)
            misaligned.push(`${offset}: ${line}`);
        }

        expect(checked).toBeGreaterThan(0);
        expect(misaligned).toEqual([]);
      });

      it("uses exactly one separator width", () => {
        const widths = [...skill.matchAll(/^─+$/gm)].map((m) => m[0].length);
        expect(widths.length).toBeGreaterThan(0);
        expect(new Set(widths)).toEqual(new Set([GEOMETRY.SEPARATOR_WIDTH]));
      });

      it("introduces no box-drawing border characters", () => {
        expect(skill).not.toMatch(/[╭╮╰╯┌┐└┘├┤┬┴┼]/);
      });
    });
  }
});
