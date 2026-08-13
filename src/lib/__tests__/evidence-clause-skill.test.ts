/**
 * CI gate for the explicit `Evidence:` clause skill wiring (issue #938).
 *
 * The parser/linter halves of #938 have runtime TypeScript twins covered by
 * `ac-parser.test.ts` and `ac-linter.test.ts`. The skill halves (AC-3, AC-4)
 * are prose-only, so these tests assert the *presence and wiring* of the
 * skill text, mirroring `trust-model-skill.test.ts`'s pattern:
 *
 * - AC-3: `/spec`'s testgen recommendation counts declared-evidence ACs
 *   before inferred ones.
 * - AC-4: `/qa` §6g requires a declared evidence command to be executed (or
 *   a captured run verified) before an evidence-bearing AC is MET, and that
 *   check is wired into §7's verdict algorithm and required in both QA
 *   modes.
 *
 * Assertions are scoped to the delimited section they mean to check (per
 * `feedback_gate_test_scope_mutation.md` — a whole-file match lets an
 * unrelated header satisfy the assertion). Mirroring across the three skill
 * dirs is enforced separately by `npm run lint:skill-sync`.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

describe("/spec testgen recommendation counts declared evidence first (AC-3)", () => {
  const spec = () => read(".claude/skills/spec/SKILL.md");

  const testgenSection = (content: string): string => {
    const start = content.indexOf("### Testgen Phase Auto-Detection");
    const end = content.indexOf("### Browser Testing Label Suggestion");
    expect(
      start,
      "Testgen Phase Auto-Detection section must exist",
    ).toBeGreaterThan(-1);
    expect(
      end,
      "Browser Testing Label Suggestion section must exist",
    ).toBeGreaterThan(start);
    return content.slice(start, end);
  };

  it("scopes to a non-empty section between the expected headers", () => {
    expect(testgenSection(spec()).length).toBeGreaterThan(0);
  });

  it("the detection logic counts declared evidence before inferred", () => {
    const section = testgenSection(spec());
    expect(section).toMatch(/declared/i);
    expect(section).toMatch(/AC\.evidence/);
    expect(section).toMatch(
      /before.{0,20}inferred|inferred.{0,20}fallback|falling back to keyword inference/i,
    );
  });

  it("the recommendation example cites a declared-evidence AC, not a bare keyword", () => {
    const section = testgenSection(spec());
    // The pre-#938 example said only "ACs include Unit Test verification
    // methods" — no citation of which AC or why. Post-#938 it must name a
    // concrete declared-evidence AC.
    expect(section).toMatch(/AC-1 declares evidence/);
  });
});

describe("/qa §6g Declared-Evidence Execution is wired (AC-4)", () => {
  const qa = () => read(".claude/skills/qa/SKILL.md");

  it("qa SKILL.md carries the §6g section with its required-command instruction", () => {
    const content = qa();
    expect(content).toContain("### 6g. Declared-Evidence Execution");
    // The core AC-4 requirement: execute (or verify a captured run of) the
    // declared command before marking the AC MET.
    expect(content).toMatch(/execute the exact backtick-quoted command/i);
    expect(content).toMatch(
      /before (that AC is |marking (that|the) AC )`?MET/i,
    );
  });

  it("§7 step 2 declares declared_evidence_status as a verification gate", () => {
    expect(qa()).toMatch(
      /^\s*-\s*declared_evidence_status = status from Section 6g/m,
    );
  });

  it("§7 step 4 floors 'Incomplete' at AC_MET_BUT_NOT_A_PLUS", () => {
    // The branch and its consequent must be adjacent — a gate declared but
    // never branched on is exactly the #834 gap class this asserts against.
    expect(qa()).toMatch(
      /ELSE IF declared_evidence_status == "Incomplete":\s*\n\s*→ AC_MET_BUT_NOT_A_PLUS/,
    );
  });

  it("§6g is required in Simple Fix mode, not omitted with the other conditional sections", () => {
    const content = qa();
    const simpleFix = content.slice(
      content.indexOf("### Simple Fix Mode (`SMALL_DIFF=true`)"),
      content.indexOf("### Standard QA (Implementation Exists"),
    );
    expect(simpleFix.length).toBeGreaterThan(0);
    // Present in the required list...
    expect(simpleFix).toMatch(/- \[ \] \*\*Declared-Evidence Execution\*\*/);
    // ...and absent from the omitted list above it.
    const omitted = simpleFix.slice(
      0,
      simpleFix.indexOf("**Required sections"),
    );
    expect(omitted).not.toMatch(/^- Declared-Evidence Execution$/m);
  });

  it("§6g is included in the Standard QA required-sections checklist", () => {
    const content = qa();
    const standard = content.slice(
      content.indexOf("### Standard QA (Implementation Exists"),
      content.indexOf(
        "## Output Verification",
        content.indexOf("### Standard QA"),
      ) === -1
        ? content.length
        : content.length,
    );
    expect(standard).toMatch(/- \[ \] \*\*Declared-Evidence Execution\*\*/);
  });

  it("both the Simple Fix and Standard output templates carry a Declared-Evidence Execution table", () => {
    const content = qa();
    const simpleTemplate = content.slice(
      content.indexOf("### Simple Fix Template"),
      content.indexOf("### Standard Template"),
    );
    const standardTemplate = content.slice(
      content.indexOf("### Standard Template"),
    );

    expect(simpleTemplate).toMatch(/### Declared-Evidence Execution/);
    expect(standardTemplate).toMatch(/### Declared-Evidence Execution/);
  });
});
