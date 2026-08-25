/**
 * CI gate for /qa §9's orchestrated-mode posting contract (issue #964, AC-5).
 *
 * #964's runtime half lives in `batch-executor.ts` (`postQaVerdictComment`,
 * unit-tested in `batch-executor.test.ts`). This is the prose half: §9 of
 * `qa/SKILL.md` must tell the orchestrated agent that `batch-executor.ts`
 * posts the verdict comment itself — the pre-#964 wording promised an
 * "aggregated summary" no runtime code backed, which is exactly how a stale,
 * contradicted verdict stayed the only externally-visible one.
 *
 * Style follows `qa-oneshot-skill.test.ts` (#853):
 * - presence asserted in all three mirrored skill dirs (`lint:skill-sync`
 *   only checks the mirrors against *each other* — the #830 hole);
 * - content assertions scoped to the delimited §9 region, not the whole
 *   file, so unrelated prose (this SKILL.md mentions verdicts everywhere)
 *   cannot satisfy them (#830 rule).
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SKILL_ROOTS = [".claude/skills", "skills", "templates/skills"] as const;

const SECTION_HEADING = "### 9. Update GitHub Issue";

const read = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

/**
 * The delimited §9 region: from its `###` heading to the next `###` heading.
 */
function section9Region(content: string): string | undefined {
  const start = content.indexOf(SECTION_HEADING);
  if (start === -1) return undefined;
  const rest = content.slice(start + SECTION_HEADING.length);
  const next = rest.search(/^### /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("qa SKILL.md §9 orchestrated-mode posting contract (#964 AC-5)", () => {
  it.each(SKILL_ROOTS)("%s/qa/SKILL.md carries the §9 section", (root) => {
    expect(read(`${root}/qa/SKILL.md`)).toContain(SECTION_HEADING);
  });

  it.each(SKILL_ROOTS)(
    "%s/qa/SKILL.md §9 names batch-executor.ts as the orchestrated poster, not an unbacked aggregated summary",
    (root) => {
      const region = section9Region(read(`${root}/qa/SKILL.md`));
      expect(region, "§9 region must be present").toBeDefined();
      // The real mechanism, by name — the runtime twin this prose describes.
      expect(region!).toContain("batch-executor.ts");
      // The machine marker the runtime emits, so the doc and marker can't
      // drift apart silently.
      expect(region!).toContain("SEQUANT_QA_VERDICT");
      // The issue that closed the doc/runtime gap.
      expect(region!).toContain("#964");
      // The pre-#964 promise must NOT survive: "orchestrator handles
      // aggregated summary" was the wording nothing backed.
      expect(region!).not.toContain("orchestrator handles aggregated summary");
    },
  );
});
