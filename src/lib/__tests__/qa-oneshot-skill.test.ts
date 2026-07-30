/**
 * CI gate for the /qa "One-Shot Turn" contract (issue #853).
 *
 * The AC-2/AC-3 half of #853 is prose-only — the phase prompt and the qa
 * SKILL.md tell the agent its turn is one-shot and that an unreviewable tree
 * is itself a verdict. There is no runtime TypeScript twin for that text, so
 * these tests assert its *presence and wiring*, in the same style as
 * `trust-model-skill.test.ts` (#819):
 *
 * - the One-Shot section exists in all three mirrored skill dirs (deleting it
 *   from all three keeps `lint:skill-sync` green — the mirrors only assert
 *   equality with *each other*, which is exactly the #830 hole);
 * - the section's assertions are scoped to the delimited One-Shot region, not
 *   the whole file, so unrelated prose cannot satisfy them (#830 rule);
 * - the `qa` promptTemplate (the first line the agent sees) and its aider
 *   driverOverride carry the same one-shot constraint.
 *
 * The behavioral half ("a live agent actually emits a verdict instead of
 * deferring") is LLM behavior and not CI-gateable; it is covered by the
 * runtime classification split in `phase-executor.ts` (`endedWithoutVerdict`,
 * unit-tested + mutation-verified) plus a documented Manual Test Override in
 * the QA record on #853.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { phaseRegistry } from "../workflow/phase-registry.js";

const SKILL_ROOTS = [".claude/skills", "skills", "templates/skills"] as const;

const ONE_SHOT_HEADING = "## One-Shot Turn — Always Emit a Verdict";

const read = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

/**
 * The delimited One-Shot region: from its `##` heading to the next `##`
 * heading. Scoping assertions here (not the whole file) is the #830 rule —
 * `qa/SKILL.md` mentions verdicts and CI everywhere, so whole-file matches
 * would survive deletion of the actual block.
 */
function oneShotRegion(content: string): string | undefined {
  const start = content.indexOf(ONE_SHOT_HEADING);
  if (start === -1) return undefined;
  const rest = content.slice(start + ONE_SHOT_HEADING.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("qa SKILL.md One-Shot Turn section (#853 AC-2/AC-3)", () => {
  it.each(SKILL_ROOTS)(
    "%s/qa/SKILL.md carries the One-Shot section",
    (root) => {
      expect(read(`${root}/qa/SKILL.md`)).toContain(ONE_SHOT_HEADING);
    },
  );

  it("names the unavailable escape hatches: later turn and background poll", () => {
    const region = oneShotRegion(read(".claude/skills/qa/SKILL.md"));
    expect(region, "One-Shot region must be present").toBeDefined();
    expect(region!.toLowerCase()).toContain("later turn");
    expect(region!.toLowerCase()).toContain("background poll");
    expect(region!.toLowerCase()).toMatch(/single-shot|one-shot/);
  });

  it("requires a `### Verdict:` line before the turn ends", () => {
    const region = oneShotRegion(read(".claude/skills/qa/SKILL.md"));
    expect(region!).toMatch(/### Verdict:/);
  });

  it("maps the unreviewable-tree cases to real verdicts (AC-3), never silence", () => {
    const region = oneShotRegion(read(".claude/skills/qa/SKILL.md"));
    // The two unreviewable-tree rows must map to existing verdict values…
    expect(region!).toContain("`AC_NOT_MET`");
    expect(region!).toContain("`NEEDS_VERIFICATION`");
    // …and the never-end-silently rule must be stated in the region itself.
    expect(region!.toLowerCase()).toMatch(/never end/);
  });
});

describe("qa phase prompt carries the one-shot constraint (#853 AC-2)", () => {
  it("default promptTemplate states the turn is one-shot and demands a Verdict line", () => {
    const template = phaseRegistry.get("qa").promptTemplate;
    expect(template.toLowerCase()).toContain("one-shot");
    expect(template).toContain("### Verdict:");
    expect(template.toLowerCase()).toMatch(/defer/);
  });

  it("aider driverOverride states the same constraint", () => {
    const aider =
      phaseRegistry.get("qa").driverOverrides?.aider?.promptTemplate;
    expect(aider, "qa aider override must exist").toBeDefined();
    expect(aider!.toLowerCase()).toContain("one-shot");
    expect(aider!.toLowerCase()).toContain("never end without a verdict");
  });
});
