/**
 * CI gate for `/qa`'s Follow-up Ledger (#1249, AC-1).
 *
 * Every item an earlier phase deferred must end `filed #N`, `fixed in this PR`
 * or `dropped: <reason>`, and an unresolved one keeps the verdict below
 * `READY_FOR_MERGE`. The rule is prose, so the assertions are scoped to the
 * delimited `#### Follow-up Ledger` block under §7, and the wiring is judged by
 * `scripts/lint-skill-gates.ts`'s own parsers — the ones that decide whether a
 * §7 gate is reachable at all.
 *
 * Every skill copy is checked, so a partial edit fails here even before
 * `lint:skill-sync` runs.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  collectFiles,
  SKILL_ROOTS,
} from "../../../scripts/check-skill-sync.js";
import {
  parseChecklists,
  parseTemplateSections,
  parseVerdictAlgorithm,
} from "../../../scripts/lint-skill-gates.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const TOKEN = "followup_ledger_status";

/** Read `rel` from each skill root via the production walker. */
function readFromEachRoot(rel: string): Array<{ root: string; text: string }> {
  return SKILL_ROOTS.map((root) => {
    const base = path.join(REPO_ROOT, root);
    const found = collectFiles(base).find((f) => f === rel);
    if (!found) throw new Error(`${rel} not found under ${root}`);
    return { root, text: fs.readFileSync(path.join(base, found), "utf-8") };
  });
}

/** Slice `text` from `startMarker` up to (not including) `endMarker`. */
function span(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + 1);
  if (start === -1 || end === -1) {
    throw new Error(`span ${startMarker} .. ${endMarker} not found`);
  }
  return text.slice(start, end);
}

/** The ledger block only: its heading up to §7's next bold sub-heading. */
function ledgerBlock(skill: string): string {
  return span(
    skill,
    "#### Follow-up Ledger",
    "**Browser Testing Enforcement:**",
  );
}

/** The step-4 branch on the ledger token, up to the next branch. */
function ledgerBranch(skill: string): string {
  return span(
    skill,
    `ELSE IF ${TOKEN} == "Unresolved"`,
    "   - ELSE IF settle_evidence_status",
  );
}

describe("qa Follow-up Ledger (#1249 AC-1)", () => {
  it("is a §7 gate: a step-2 token with a step-4 branch", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      const algorithm = parseVerdictAlgorithm(text);
      expect(algorithm, root).not.toBeNull();
      expect(algorithm!.step2Tokens.get(TOKEN), root).toBe("7");
      expect(algorithm!.step4Tokens.has(TOKEN), root).toBe(true);
    }
  });

  it("caps an unresolved ledger at AC_MET_BUT_NOT_A_PLUS", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      const branch = ledgerBranch(text);
      expect(branch, root).toContain("→ AC_MET_BUT_NOT_A_PLUS");
      expect(branch, root).not.toContain("→ AC_NOT_MET");
    }
  });

  it("names the three terminal states and every deferred-item source", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      const block = ledgerBlock(text);
      for (const expected of [
        "`filed #N`",
        "`fixed in this PR`",
        "`dropped: <reason>`",
        "spec's Open Questions",
        "exec's PR-body follow-ups",
        '`recommendedAction: "document"`',
        "**Resolved**",
        "**Unresolved**",
        "**N/A**",
        "## Follow-ups",
      ]) {
        expect(block, `${root}: ${expected}`).toContain(expected);
      }
    }
  });

  it("has an output slot and a checklist entry in both modes", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      const templates = parseTemplateSections(text);
      expect(templates.standard, root).toContain("Follow-up Ledger");
      expect(templates.simpleFix, root).toContain("Follow-up Ledger");
      const checklists = parseChecklists(text);
      expect(checklists.standard, root).toContain("Follow-up Ledger");
      expect(checklists.simpleFixRequired, root).toContain("Follow-up Ledger");
    }
  });

  it("no longer tells QA to defer by filing a follow-up it never files", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      const scan = span(
        text,
        "#### Sibling-site Scan",
        "#### Skill Change Review",
      );
      expect(scan, root).not.toContain("file a follow-up issue instead");
      expect(scan, root).toContain("Follow-up Ledger");
    }
  });
});
