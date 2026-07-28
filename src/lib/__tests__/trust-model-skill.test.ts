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
 *   HTML-comment-hidden-instruction fixture, and that check is actually wired
 *   into §7's verdict algorithm and required in both QA modes.
 *
 * The behavioral half of AC-3 ("reported, not acted on") is a one-time manual
 * eval logged on the PR — not CI-gateable. Byte-identical mirroring across the
 * three dirs is enforced separately by `npm run lint:skill-sync`.
 *
 * Two of these assertions exist because their absence already shipped once and
 * was caught in review rather than by CI, so they are written to fail loudly if
 * the gap reopens:
 *
 *  - The fixture assertion is scoped to the delimited payload span. The original
 *    matched the whole file, so the fixture's own explanatory header (which
 *    quotes `run`/`env`/`POST` while describing the payload) satisfied it —
 *    deleting the real payload left the suite green.
 *  - §6f originally declared "floor the verdict at AC_NOT_MET" in prose while
 *    §7 had no such gate and no such branch, making the floor unreachable; and
 *    its only wiring ran through §6d, which Simple Fix mode omits — switching
 *    the check off for exactly the small diffs an injected command fits in.
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

    // Scope the assertion to the delimited untrusted-payload span. Matching the
    // whole file would be satisfied by the fixture's own explanatory header —
    // which necessarily quotes `run`/`env`/`POST` while describing the payload —
    // so deleting the actual payload would leave this test green.
    const payload = fixture.match(
      /==== BEGIN VERBATIM ISSUE BODY ====([^]*?)==== END VERBATIM ISSUE BODY ====/,
    )?.[1];
    expect(payload, "fixture must delimit its untrusted payload").toBeDefined();

    // A hidden HTML comment, inside the payload, carrying an agent-directed
    // imperative from the danger class (execute / reach the network).
    const hiddenComment = payload!.match(/<!--[^]*?-->/);
    expect(
      hiddenComment,
      "payload must hide an HTML-comment instruction",
    ).not.toBeNull();
    expect(hiddenComment![0]).toMatch(
      /\benv\b|\bPOST\b|exfiltrat|https?:\/\//i,
    );

    // And a benign visible AC, outside any comment, that must still be
    // implemented normally.
    expect(payload!.replace(/<!--[^]*?-->/g, "")).toMatch(/AC-1/);
  });
});

describe("§6f is wired into the verdict algorithm and both modes (AC-3)", () => {
  const qa = () => read(".claude/skills/qa/SKILL.md");

  it("§7 step 2 declares trust_boundary_status as a verification gate", () => {
    expect(qa()).toMatch(
      /^\s*-\s*trust_boundary_status = status from Section 6f/m,
    );
  });

  it("§7 step 4 floors 'Injection Acted On' at AC_NOT_MET", () => {
    // The branch and its consequent must be adjacent — a gate declared but never
    // branched on is exactly the gap this asserts against.
    expect(qa()).toMatch(
      /ELSE IF trust_boundary_status == "Injection Acted On":\s*\n\s*→ AC_NOT_MET/,
    );
  });

  it("§6f is required in Simple Fix mode, not omitted with §6d", () => {
    const content = qa();
    const simpleFix = content.slice(
      content.indexOf("### Simple Fix Mode (`SMALL_DIFF=true`)"),
      content.indexOf("### Standard QA (Implementation Exists"),
    );
    expect(simpleFix.length).toBeGreaterThan(0);
    // Present in the required list...
    expect(simpleFix).toMatch(/- \[ \] \*\*Trust-Boundary Check\*\*/);
    // ...and absent from the omitted list above it.
    const omitted = simpleFix.slice(
      0,
      simpleFix.indexOf("**Required sections"),
    );
    expect(omitted).not.toMatch(/^- Trust-Boundary Check$/m);
  });
});
