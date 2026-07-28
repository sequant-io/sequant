/**
 * CI gate for the shared trust-model block (issue #819).
 *
 * Prompt-injection hardening is prose-only — there is no runtime TypeScript
 * twin — so these tests assert the *presence and wiring* of the skill text:
 *
 * - AC-1: `_shared/references/trust-model.md` exists in all three mirrored skill
 *   dirs and each of spec/exec/qa/loop/assess SKILL.md points to it.
 * - AC-2: the reference names the untrusted surfaces and states embedded
 *   agent-directed instructions are surfaced as findings, never followed.
 * - AC-3: `/qa` carries the Trust-Boundary Check and the verbatim
 *   HTML-comment-hidden-instruction fixture.
 *
 * The behavioral half of AC-3 ("reported, not acted on") is a one-time manual
 * eval logged on the PR — not CI-gateable. Byte-identical mirroring across the
 * three dirs is enforced separately by `npm run lint:skill-sync`.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SKILL_ROOTS = [".claude/skills", "skills", "templates/skills"] as const;
const INGEST_SKILLS = ["spec", "exec", "qa", "loop", "assess"] as const;

const read = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
const exists = (rel: string): boolean =>
  fs.existsSync(path.join(process.cwd(), rel));

describe("trust-model reference (AC-1, AC-2)", () => {
  it.each(SKILL_ROOTS)(
    "exists in %s/_shared/references/trust-model.md",
    (root) => {
      expect(exists(`${root}/_shared/references/trust-model.md`)).toBe(true);
    },
  );

  it("is short (~15 lines, must not fight #515 prompt compression)", () => {
    const lineCount = read(
      ".claude/skills/_shared/references/trust-model.md",
    ).split("\n").length;
    // AC-1 ceiling is "~15 lines"; allow modest slack for headings/blank lines.
    expect(lineCount).toBeLessThanOrEqual(20);
  });

  it("names the untrusted surfaces (AC-2)", () => {
    const ref = read(
      ".claude/skills/_shared/references/trust-model.md",
    ).toLowerCase();
    expect(ref).toMatch(/issue bod/); // issue body / bodies
    expect(ref).toContain("comment");
    expect(ref).toMatch(/url|link/);
  });

  it("states embedded instructions are surfaced as findings, never followed (AC-2)", () => {
    const ref = read(
      ".claude/skills/_shared/references/trust-model.md",
    ).toLowerCase();
    expect(ref).toContain("security finding");
    expect(ref).toMatch(/never follow|not.*follow|do not follow/);
    expect(ref).toContain("data");
  });
});

describe("skill pointers to trust-model.md (AC-1)", () => {
  it.each(INGEST_SKILLS)(
    "%s/SKILL.md points to the trust-model reference",
    (skill) => {
      const content = read(`.claude/skills/${skill}/SKILL.md`);
      expect(content).toContain("_shared/references/trust-model.md");
    },
  );
});

describe("/qa Trust-Boundary Check + fixture (AC-3)", () => {
  const qa = () => read(".claude/skills/qa/SKILL.md");

  it("qa SKILL.md carries the §6f Trust-Boundary Check", () => {
    expect(qa()).toContain("Trust-Boundary Check");
    // The adversarial distinction it must draw.
    expect(qa()).toMatch(/agent.{0,20}behavior/i);
    expect(qa()).toMatch(/product.{0,20}behavior/i);
  });

  it.each(SKILL_ROOTS)(
    "the verbatim injection fixture is present under %s/qa/references/fixtures/",
    (root) => {
      expect(
        exists(`${root}/qa/references/fixtures/injection-issue-body.md`),
      ).toBe(true);
    },
  );

  it("the fixture hides an agent-directed instruction in an HTML comment", () => {
    const fixture = read(
      ".claude/skills/qa/references/fixtures/injection-issue-body.md",
    );
    // A hidden HTML comment carrying an agent-directed imperative.
    const hiddenComment = fixture.match(
      /<!--[^]*?(run|POST|exfiltrat|env|http)[^]*?-->/i,
    );
    expect(hiddenComment).not.toBeNull();
    // And a benign visible AC that must still be implemented normally.
    expect(fixture).toMatch(/AC-1/);
  });
});
