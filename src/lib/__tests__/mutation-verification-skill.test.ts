/**
 * CI gate for the `/qa` §6i Mutation Verification skill wiring (issue #939).
 *
 * The marker parser has a runtime TypeScript twin covered by
 * `mutation-marker.test.ts` and the gate-test classifier by
 * `ac-parser.test.ts`. The skill half (§6i itself, and its §7 wiring) is
 * prose-only, so these tests assert the *presence and wiring* of the skill
 * text, mirroring `evidence-clause-skill.test.ts`'s pattern for §6h — the
 * immediate precedent this section replicates.
 *
 * - AC-1: `/qa` §6i exists and declares the four statuses; §7 step 2 declares
 *   `mutation_verification_status` attributed to Section 6i.
 * - AC-2: §7 step 4 floors `Failed` at `AC_NOT_MET` and caps `Missing` at
 *   `AC_MET_BUT_NOT_A_PLUS`.
 * - AC-4: §6i is required in both Simple Fix and Standard QA modes, with a
 *   matching output-template stub in both — the same structural shape
 *   `scripts/lint-skill-gates.ts` (I1–I4) verifies generically. This file
 *   pins the specific prose those invariants don't check.
 *
 * Assertions are scoped to the delimited section they mean to check (per
 * `feedback_gate_test_scope_mutation.md`). Mirroring across the three skill
 * dirs is enforced separately by `npm run lint:skill-sync`.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

const qa = () => read(".claude/skills/qa/SKILL.md");

describe("/qa §6i Mutation Verification is wired (AC-1, AC-2, AC-4)", () => {
  it("qa SKILL.md carries the §6i section with all four status outcomes", () => {
    const content = qa();
    expect(content).toContain("### 6i. Mutation Verification");
    expect(content).toMatch(/\*\*Verified\*\*/);
    expect(content).toMatch(/\*\*Missing\*\*/);
    expect(content).toMatch(/\*\*Failed\*\*/);
    expect(content).toMatch(/Not-Applicable/);
  });

  it("§6i names the two mutation-testing safety rules from the tailored caveats", () => {
    const content = qa();
    const start = content.indexOf("### 6i. Mutation Verification");
    const end = content.indexOf("### 7. A+ Status Verdict");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = content.slice(start, end);
    expect(section).toMatch(/commit before mutating/i);
    expect(section).toMatch(/finally.{0,40}rmSync/i);
  });

  it("§7 step 2 declares mutation_verification_status attributed to Section 6i", () => {
    expect(qa()).toMatch(
      /^\s*-\s*mutation_verification_status = status from Section 6i/m,
    );
  });

  it("§7 step 4 floors 'Failed' at AC_NOT_MET", () => {
    // Branch and consequent must be adjacent — a gate declared but never
    // branched on is exactly the #834 gap class this asserts against.
    expect(qa()).toMatch(
      /ELSE IF mutation_verification_status == "Failed":\s*\n\s*→ AC_NOT_MET/,
    );
  });

  it("§7 step 4 caps 'Missing' at AC_MET_BUT_NOT_A_PLUS", () => {
    expect(qa()).toMatch(
      /ELSE IF mutation_verification_status == "Missing":\s*\n\s*→ AC_MET_BUT_NOT_A_PLUS/,
    );
  });

  it("the Failed branch is ordered among the other hard AC_NOT_MET floors, before the soft-fail chain", () => {
    const content = qa();
    const failedIdx = content.indexOf(
      'ELSE IF mutation_verification_status == "Failed"',
    );
    const skillVerificationIdx = content.indexOf(
      'ELSE IF skill_verification == "Failed"',
    );
    expect(failedIdx).toBeGreaterThan(-1);
    expect(skillVerificationIdx).toBeGreaterThan(-1);
    // skill_verification == "Failed" is the first soft-fail branch in the
    // chain; a hard floor must precede it.
    expect(failedIdx).toBeLessThan(skillVerificationIdx);
  });

  it("§6i is required in Simple Fix mode, not omitted with the other conditional sections", () => {
    const content = qa();
    const simpleFix = content.slice(
      content.indexOf("### Simple Fix Mode (`SMALL_DIFF=true`)"),
      content.indexOf("### Standard QA (Implementation Exists"),
    );
    expect(simpleFix.length).toBeGreaterThan(0);
    expect(simpleFix).toMatch(/- \[ \] \*\*Mutation Verification\*\*/);
    const omitted = simpleFix.slice(
      0,
      simpleFix.indexOf("**Required sections"),
    );
    expect(omitted).not.toMatch(/^- Mutation Verification$/m);
  });

  it("§6i is included in the Standard QA required-sections checklist", () => {
    const content = qa();
    const standard = content.slice(
      content.indexOf("### Standard QA (Implementation Exists"),
    );
    expect(standard).toMatch(/- \[ \] \*\*Mutation Verification\*\*/);
  });

  it("both the Simple Fix and Standard output templates carry a Mutation Verification table", () => {
    const content = qa();
    const simpleTemplate = content.slice(
      content.indexOf("### Simple Fix Template"),
      content.indexOf("### Standard Template"),
    );
    const standardTemplate = content.slice(
      content.indexOf("### Standard Template"),
    );

    expect(simpleTemplate).toMatch(/### Mutation Verification/);
    expect(standardTemplate).toMatch(/### Mutation Verification/);
  });

  it("scripts/lint-skill-gates.ts reports zero violations against the shipped skill (I1-I4)", async () => {
    const { lintSkillGates } =
      await import("../../../scripts/lint-skill-gates.ts");
    const result = lintSkillGates(process.cwd());
    expect(result.violations).toEqual([]);
  });
});
