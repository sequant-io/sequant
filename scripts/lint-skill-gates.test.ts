import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  canonicalizeSectionName,
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  lintSkillContent,
  lintSkillGates,
  parseChecklists,
  parseDeclaredOutputName,
  parseAcHeaderPattern,
  parseEvidenceAcIdPattern,
  parseEvidenceAcPattern,
  parseSections,
  parseTemplateSections,
  parseVerdictAlgorithm,
  type Violation,
} from "./lint-skill-gates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const QA_SKILL = join(PROJECT_ROOT, ".claude/skills/qa/SKILL.md");

/**
 * The passing fixture for every invariant is the REAL shipped `qa/SKILL.md`.
 *
 * Failing fixtures are that same content with one specific piece of wiring
 * deleted — i.e. the historical defect restored. Nothing here is synthesized,
 * so a fixture cannot drift into agreeing with a bug the real file no longer
 * has (see feedback_synthetic_test_fixture_trap), and each pair doubles as a
 * live gate on the real file's wiring.
 */
function realSkill(): string {
  return readFileSync(QA_SKILL, "utf-8");
}

/**
 * Delete or rewrite an exact span, asserting it was present first.
 *
 * Without the assertion, a reworded SKILL.md would silently turn the mutation
 * into a no-op and the "must fail" expectation would fail for a confusing
 * reason. This makes the cause explicit.
 */
function mutate(content: string, from: string, to = ""): string {
  expect(
    content.includes(from),
    `mutation target not found in qa/SKILL.md — update this fixture:\n${from}`,
  ).toBe(true);
  return content.replace(from, to);
}

function invariants(violations: Violation[]): string[] {
  return violations.map((v) => v.invariant);
}

function messagesFor(violations: Violation[], invariant: string): string[] {
  return violations
    .filter((v) => v.invariant === invariant)
    .map((v) => v.message);
}

// The two wiring lines that #834 added for §2h. Both are real defect sites:
// §2h shipped with NEITHER, which is why its `CRITICAL` gate never fired.
const STEP2_CLI_TOKEN =
  "   - cli_registration_status = status from Section 2h (Passed/Failed/N/A)";
const STEP4_CLI_BRANCH = '   - ELSE IF cli_registration_status == "Failed":';

describe("lint-skill-gates parsers", () => {
  it("parses the real qa/SKILL.md verdict algorithm into gates and branches", () => {
    const algorithm = parseVerdictAlgorithm(realSkill());
    expect(algorithm).not.toBeNull();
    // Every step-2 gate must be branched in step 4 — this is I1's substrate.
    expect(algorithm!.step2Tokens.size).toBeGreaterThan(5);
    expect(algorithm!.step2Tokens.get("cli_registration_status")).toBe("2h");
    expect(algorithm!.step4Tokens.has("cli_registration_status")).toBe(true);
  });

  it("ignores headings inside fenced blocks when splitting sections", () => {
    const sections = parseSections(realSkill());
    const ids = sections.map((s) => s.id);
    // §2h's body must survive intact despite the nested ```typescript fence in
    // its remediation block; if fence tracking broke, the body would be cut off
    // before the Verdict Gating table.
    expect(ids).toContain("2h");
    const section2h = sections.find((s) => s.id === "2h")!;
    expect(section2h.body).toContain("Maximum Verdict");
    // The output templates contain `## QA Review for Issue #<N>` inside fences;
    // those must not register as section boundaries.
    expect(ids).toContain("11a");
  });

  it("reads a section's declared output name, and null when it declares none", () => {
    const sections = parseSections(realSkill());
    const byId = new Map(sections.map((s) => [s.id, s]));
    expect(parseDeclaredOutputName(byId.get("2h")!)).toBe(
      "CLI Registration Verification",
    );
    expect(parseDeclaredOutputName(byId.get("6f")!)).toBe(
      "Trust-Boundary Check",
    );
    // §4 is an analysis checklist with no output block. A section that declares
    // no output section cannot be listed in an output checklist, which is why
    // I3 exempts it by construction rather than by allowlist.
    expect(parseDeclaredOutputName(byId.get("4")!)).toBeNull();
  });

  it("canonicalizes template placeholders and aliased labels to one key", () => {
    expect(
      canonicalizeSectionName(
        "Verdict: [READY_FOR_MERGE | AC_MET_BUT_NOT_A_PLUS | NEEDS_VERIFICATION | AC_NOT_MET]",
      ),
    ).toBe("verdict");
    expect(canonicalizeSectionName("Code Review Findings")).toBe("code review");
    expect(canonicalizeSectionName("Documentation Check")).toBe(
      "documentation",
    );
    // A non-aliased name is only normalized, never rewritten.
    expect(canonicalizeSectionName("Trust-Boundary Check")).toBe(
      "trust-boundary check",
    );
  });
});

describe("I1 — a declared verdict floor must be reachable from §7", () => {
  it("passes on the real qa/SKILL.md (every floor is wired)", () => {
    const content = realSkill();
    const algorithm = parseVerdictAlgorithm(content)!;
    const sections = parseSections(content);
    const algorithmSection = sections.find((s) =>
      s.body.includes("Verdict Determination Algorithm"),
    )!;
    expect(checkI1(sections, algorithm, algorithmSection.id)).toEqual([]);
  });

  it("fails when a floor-declaring section has no step-2 gate (§2h as shipped)", () => {
    // Restores the exact defect #834 was filed for: §2h's `CRITICAL: ... verdict
    // CANNOT be READY_FOR_MERGE` with nothing in §7 that reads it.
    let content = realSkill();
    content = mutate(content, `${STEP2_CLI_TOKEN}`, "");
    content = mutate(content, `${STEP4_CLI_BRANCH}`, "");

    const algorithm = parseVerdictAlgorithm(content)!;
    const sections = parseSections(content);
    const algorithmSection = sections.find((s) =>
      s.body.includes("Verdict Determination Algorithm"),
    )!;
    const violations = checkI1(sections, algorithm, algorithmSection.id);

    expect(violations).toHaveLength(1);
    expect(violations[0].subject).toBe("§2h");
    expect(violations[0].message).toContain("no §7");
    expect(violations[0].message).toContain("Section 2h");
  });

  it("fails when a step-2 gate exists but step 4 never branches on it (#819 F1)", () => {
    // #819's §6f shipped declaring "floor the verdict at AC_NOT_MET" with no
    // step-4 branch, so a real prompt injection could reach at most
    // AC_MET_BUT_NOT_A_PLUS. Same shape, reproduced on §2h's branch.
    const content = mutate(realSkill(), STEP4_CLI_BRANCH, "");

    const algorithm = parseVerdictAlgorithm(content)!;
    const sections = parseSections(content);
    const algorithmSection = sections.find((s) =>
      s.body.includes("Verdict Determination Algorithm"),
    )!;
    const violations = checkI1(sections, algorithm, algorithmSection.id);

    expect(violations).toHaveLength(1);
    expect(violations[0].subject).toBe("§2h");
    expect(violations[0].message).toContain("never branches on it");
    expect(violations[0].message).toContain("cli_registration_status");
  });

  it("does not false-positive on §6a, whose token has no `_status` suffix", () => {
    // A name-shape heuristic (`[a-z_]+_status`) would flag §6a, §6c and §6d.
    // I1 asks §7 which section a token is attributed to instead.
    const content = realSkill();
    const algorithm = parseVerdictAlgorithm(content)!;
    expect(algorithm.step2Tokens.get("skill_verification")).toBe("6a");
    const sections = parseSections(content);
    const flagged = checkI1(sections, algorithm, "7").map((v) => v.subject);
    expect(flagged).not.toContain("§6a");
  });
});

describe("I2 — every §7 step-2 gate must name a section that exists", () => {
  it("passes on the real qa/SKILL.md", () => {
    const content = realSkill();
    expect(
      checkI2(parseSections(content), parseVerdictAlgorithm(content)!),
    ).toEqual([]);
  });

  it("fails on a gate attributed to a nonexistent section", () => {
    const content = mutate(
      realSkill(),
      STEP2_CLI_TOKEN,
      "   - cli_registration_status = status from Section 99z (Passed/Failed/N/A)",
    );
    const violations = checkI2(
      parseSections(content),
      parseVerdictAlgorithm(content)!,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].subject).toBe("cli_registration_status");
    expect(violations[0].message).toContain("Section 99z");
    expect(violations[0].message).toContain("Orphan gate");
  });

  it("fails on a gate that names no producing section at all", () => {
    const content = mutate(
      realSkill(),
      STEP2_CLI_TOKEN,
      "   - cli_registration_status = Passed/Failed/N/A",
    );
    const violations = checkI2(
      parseSections(content),
      parseVerdictAlgorithm(content)!,
    );
    expect(messagesFor(violations, "I2").join("\n")).toContain(
      "without naming the section",
    );
  });
});

describe("I3 — a REQUIRED section needs an explicit place in both modes", () => {
  it("passes on the real qa/SKILL.md", () => {
    const content = realSkill();
    expect(checkI3(parseSections(content), parseChecklists(content))).toEqual(
      [],
    );
  });

  it("fails when Simple Fix mode is silent about a REQUIRED check (#819 F2)", () => {
    // #819 F2: §6f was REQUIRED but reachable only through §6d, which Simple Fix
    // mode omits — switching a security check off below the 100-line diff gate.
    // Here the Simple Fix checklist entry is deleted while §6f stays REQUIRED and
    // stays off the omitted list, which is exactly that silence.
    const content = mutate(
      realSkill(),
      '- [ ] **Trust-Boundary Check** - Required in simple fix mode too (see Section 6f); "Finding:" and "Status:" lines populated\n',
      "",
    );
    const violations = checkI3(
      parseSections(content),
      parseChecklists(content),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0].subject).toBe("§6f");
    expect(violations[0].message).toContain(
      "neither requires nor explicitly omits",
    );
    expect(violations[0].message).toContain("#819 F2");
  });

  it("fails when a REQUIRED section is missing from the Standard checklist", () => {
    const content = mutate(
      realSkill(),
      "- [ ] **Behavior-Rule Survival Check** - Included if any AC triggers the behavior-rule heuristic (or marked N/A — see Section 6e); `Survivors Found` floors the verdict at `AC_NOT_MET` via §7\n",
      "",
    );
    const violations = checkI3(
      parseSections(content),
      parseChecklists(content),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].subject).toBe("§6e");
    expect(violations[0].message).toContain(
      "missing from the Standard required-sections checklist",
    );
  });

  it("accepts an explicit omission as a valid answer", () => {
    // §6a is REQUIRED and absent from the Simple Fix required list, but present
    // on the omitted list. That is a decision, not silence, so I3 must pass it.
    const checklists = parseChecklists(realSkill());
    expect(checklists.simpleFixOmitted).toContain("Skill Command Verification");
    expect(checklists.simpleFixRequired).not.toContain(
      "Skill Command Verification",
    );
    expect(
      checkI3(parseSections(realSkill()), checklists)
        .map((v) => v.subject)
        .filter((s) => s === "§6a"),
    ).toEqual([]);
  });
});

describe("I4 — checklist and template must agree in both directions", () => {
  it("passes on the real qa/SKILL.md, for both modes", () => {
    const content = realSkill();
    expect(
      checkI4(parseChecklists(content), parseTemplateSections(content)),
    ).toEqual([]);
  });

  it("fails on a template section nothing in the checklist verifies", () => {
    // The pre-#834 state: the Standard template rendered a CLI Registration
    // Verification section that no checklist entry demanded, so omitting it cost
    // nothing. This is #819 F1's missing-template-section defect, inverted.
    const content = mutate(
      realSkill(),
      "- [ ] **CLI Registration Verification** - Included if option interfaces modified (or marked N/A — see Section 2h); `Failed` floors the verdict at `AC_NOT_MET` via §7\n",
      "",
    );
    const violations = checkI4(
      parseChecklists(content),
      parseTemplateSections(content),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].subject).toBe("Standard template");
    expect(violations[0].message).toContain("CLI Registration Verification");
    expect(violations[0].message).toContain("Nothing verifies it was produced");
  });

  it("fails on a checklist entry the template gives no place to satisfy", () => {
    // Mutating the parsed template list rather than the file text: §6e's own
    // Output Format block is byte-identical to the Standard template's section,
    // so a text mutation cannot target one without the other. The input is
    // still the real file's parse, with exactly one section dropped.
    const content = realSkill();
    const checklists = parseChecklists(content);
    const templates = parseTemplateSections(content);

    const dropped = "Behavior-Rule Survival Check";
    expect(templates.standard).toContain(dropped);
    const mutated = {
      ...templates,
      standard: templates.standard.filter((s) => s !== dropped),
    };

    const violations = checkI4(checklists, mutated);
    expect(violations).toHaveLength(1);
    expect(violations[0].subject).toBe("Standard checklist");
    expect(violations[0].message).toContain(dropped);
    expect(violations[0].message).toContain("has no such section");
  });
});

describe("fail-loud parsing (no silent passes)", () => {
  it("skips a skill with no verdict algorithm rather than failing it", () => {
    const result = lintSkillContent(
      "# Some Skill\n\n## Purpose\n\nDoes a thing.\n\n### 1. Step One\n\nContent.\n",
    );
    expect(result.skipped).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("reports PARSE when the algorithm block is present but unreadable", () => {
    const content = [
      "# Skill",
      "",
      "### 1. A Section",
      "",
      "Content.",
      "",
      "### 7. Verdict",
      "",
      "**Verdict Determination Algorithm (REQUIRED):**",
      "",
      "```text",
      "Nothing parseable in here at all.",
      "```",
      "",
    ].join("\n");
    const result = lintSkillContent(content);
    expect(result.skipped).toBe(false);
    expect(invariants(result.violations)).toContain("PARSE");
    expect(result.violations[0].message).toContain(
      "do not treat this as a pass",
    );
  });

  it("reports PARSE when Output Verification exists but yields no entries", () => {
    const content = realSkill().replace(
      /^- \[ \] \*\*/gm,
      "- MUTATED-CHECKLIST-SHAPE ",
    );
    const result = lintSkillContent(content);
    expect(invariants(result.violations)).toContain("PARSE");
    expect(messagesFor(result.violations, "PARSE").join("\n")).toContain(
      "zero Standard checklist entries",
    );
  });
});

describe("AC-5 — the whole project scan", () => {
  it("reports zero violations against the shipped skills", () => {
    const result = lintSkillGates(PROJECT_ROOT);
    expect(result.violations).toEqual([]);
  });

  it("skips every skill without a verdict algorithm without erroring", () => {
    const result = lintSkillGates(PROJECT_ROOT);
    expect(result.scanned).toBeGreaterThan(10);
    // `qa` is the only skill with a verdict algorithm today.
    expect(result.skipped.length).toBe(result.scanned - 1);
    expect(result.skipped).not.toContain(".claude/skills/qa/SKILL.md");
  });
});

describe("AC-3 — §2h is wired into §7", () => {
  it("declares cli_registration_status in step 2 and branches on it in step 4", () => {
    // Scoped to §7's algorithm block so a mention of the token anywhere else in
    // the file (§2h's prose, a checklist entry) cannot satisfy this assertion.
    const content = realSkill();
    const algorithm = parseVerdictAlgorithm(content)!;
    expect(algorithm.step2Tokens.get("cli_registration_status")).toBe("2h");
    expect(algorithm.step4Tokens.has("cli_registration_status")).toBe(true);
  });

  it("points §2h's prose at the step-4 branch, the way §6f does", () => {
    const section2h = parseSections(realSkill()).find((s) => s.id === "2h")!;
    expect(section2h.body).toContain('cli_registration_status == "Failed"');
    expect(section2h.body).toContain("§7 step 4");
  });
});

describe("AC-6 — §7 recognises evidence-naming ACs", () => {
  // Every test below compiles the pattern straight out of the shipped
  // SKILL.md via parseEvidenceAcPattern, rather than restating it here. That
  // keeps SKILL.md the single source of truth: weaken the shipped pattern and
  // these fail. The call is inlined per test rather than hidden behind a local
  // helper so each block visibly exercises production code.

  // #819's AC-4, verbatim from the issue body. The automated /qa pass marked
  // this MET on "unchanged by construction" reasoning; no corpus check was run,
  // and when one finally was it surfaced a real false-positive surface.
  const ISSUE_819_AC4 =
    "AC parsing and normal requirement interpretation are unchanged — an issue " +
    'body\'s legitimate imperative requirements ("add a flag that runs X") are ' +
    "still implemented normally; a corpus check against several real recent " +
    "issue bodies shows no behavior change.";

  it("matches #819's AC-4 text", () => {
    const pattern = parseEvidenceAcPattern(realSkill());
    expect(pattern).not.toBeNull();
    expect(ISSUE_819_AC4).toMatch(pattern!);
  });

  it("matches each evidence-naming phrasing the AC calls out", () => {
    const pattern = parseEvidenceAcPattern(realSkill());
    expect(pattern).not.toBeNull();
    expect("verified by a corpus check over the run logs").toMatch(pattern!);
    expect("checked against several real recent PR bodies").toMatch(pattern!);
    expect("confirmed across 12 samples from production").toMatch(pattern!);
    expect("behavior sampled from the last release").toMatch(pattern!);
  });

  it("does not match an AC that names no verification evidence", () => {
    const pattern = parseEvidenceAcPattern(realSkill())!;
    expect(pattern).not.toBeNull();
    // #834's own AC-3 — a pure structural claim, verifiable from the file itself.
    expect(
      "§2h CLI Registration Verification is wired — cli_registration_status " +
        "declared in §7 step 2 and branched in step 4 flooring at AC_NOT_MET.",
    ).not.toMatch(pattern);
    expect("The lint runs as its own CI step.").not.toMatch(pattern);
  });

  it("attributes an evidence-naming AC to its AC ID via the awk half too", () => {
    // §7 detects evidence-naming ACs with `grep`, then attributes matches to AC
    // IDs with a second `awk` pattern carrying the same terms. Mutation testing
    // showed the tests above gate only the grep line: stripping the terms from
    // awk alone left the suite green while attribution silently stopped working,
    // so detection would find the line and then report no AC for it.
    const pattern = parseEvidenceAcIdPattern(realSkill());
    expect(pattern).not.toBeNull();
    expect(ISSUE_819_AC4).toMatch(pattern!);
    expect("The lint runs as its own CI step.").not.toMatch(pattern!);
  });

  it("anchors AC attribution on every declaration form real spec comments use", () => {
    // Found by running §7's actual shell pipeline against this issue's own spec
    // comment: grep matched the evidence-naming line, then awk attributed it to
    // NO AC, because the anchor covered only `#+ AC-N` / `**AC-N` headings. A
    // measured corpus of 18 recent issues (#533–#822) put the checkbox forms at
    // 134 declarations vs 94 for the heading forms — so attribution was silent
    // for the majority of real ACs while detection reported matches.
    const pattern = parseAcHeaderPattern(realSkill());
    expect(pattern).not.toBeNull();
    for (const form of [
      "- [ ] **AC-6** verified by a corpus check of real issue bodies",
      "- [ ] AC-6 verified by a corpus check of real issue bodies",
      "### AC-6: verified by a corpus check of real issue bodies",
      "#### AC-6: verified by a corpus check",
      "**AC-6:** verified by a corpus check of real issue bodies",
    ]) {
      expect(form, `anchor fails to attribute: ${form}`).toMatch(pattern!);
    }
    // Ordinary prose must not be mistaken for a declaration, or every later
    // match would be misattributed to it.
    expect("Some prose mentioning a corpus check").not.toMatch(pattern!);
    expect("  - [ ] indented non-AC checklist item").not.toMatch(pattern!);
  });

  it("fails loud when the AC-ID attribution half loses its pattern entirely", () => {
    // Distinct from the test above: that one catches the *terms* being weakened
    // (behaviorally, via #819's AC-4); this one catches the awk match block being
    // removed outright, which would leave detection with nothing to attribute to.
    // The grep half and the awk half are checked independently.
    const awkGutted = mutate(
      realSkill(),
      "{ac=$0} /Manual Test",
      "{ac=$0} MUTATED-NO-PATTERN",
    );
    const result = lintSkillContent(awkGutted);
    const parseMessages = messagesFor(result.violations, "PARSE").join("\n");
    expect(parseMessages).toContain("AC-ID attribution half");
    // The grep half is untouched, so only one half should be reported.
    expect(parseMessages).not.toContain("its detection half");
  });

  it("fails loud when the declared enforcement has no pattern behind it", () => {
    // Deleting the shipped pattern must be a lint violation, not a silent
    // downgrade — step 3a would otherwise declare enforcement with nothing
    // behind it, the same prose-only condition I1 exists to catch.
    const content = mutate(
      realSkill(),
      "grep -iE '(\\*\\*Verification:\\*\\*\\s*Manual Test",
      "grep -F 'Manual Test",
    );
    const result = lintSkillContent(content);
    expect(invariants(result.violations)).toContain("PARSE");
    expect(messagesFor(result.violations, "PARSE").join("\n")).toContain(
      "has no detection behind it",
    );
  });
});
