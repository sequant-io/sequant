/**
 * CI gate for `/qa`'s sibling-site scan and end-to-end delivery rule (#1249,
 * AC-3 and AC-4).
 *
 * - AC-3: the `#### Sibling-site Scan` block asks for the defect class, not
 *   the symbol being changed, and the scan names the class it searched.
 * - AC-4: `### 5. Risk Assessment` forbids marking an AC's promised
 *   end-to-end delivery "Not tested": run it, or the AC is PENDING and the
 *   verdict reaches NEEDS_VERIFICATION through §7's `pending_count`.
 *
 * Assertions are scoped to the delimited section each rule lives in, so a
 * mention elsewhere in the skill cannot satisfy them. The §7 routing is judged
 * with `scripts/lint-skill-gates.ts`'s parser. Every skill copy is checked.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  collectFiles,
  SKILL_ROOTS,
} from "../../../scripts/check-skill-sync.js";
import { parseSections } from "../../../scripts/lint-skill-gates.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** Read `rel` from each skill root via the production walker. */
function readFromEachRoot(rel: string): Array<{ root: string; text: string }> {
  return SKILL_ROOTS.map((root) => {
    const base = path.join(REPO_ROOT, root);
    const found = collectFiles(base).find((f) => f === rel);
    if (!found) throw new Error(`${rel} not found under ${root}`);
    return { root, text: fs.readFileSync(path.join(base, found), "utf-8") };
  });
}

/**
 * §5's own body as `parseSections` bounds it: `### 5. Risk Assessment` up to
 * the next `##`/`###` heading outside a fence — so §5's prose, not the output
 * templates' `### Risk Assessment` copies.
 */
function section5(skill: string): string {
  const section = parseSections(skill).find((s) => s.id === "5");
  if (!section) throw new Error("### 5. Risk Assessment not found");
  return section.body;
}

/** The `#### Sibling-site Scan` block inside §5. */
function siblingScan(skill: string): string {
  const body = section5(skill);
  const start = body.indexOf("#### Sibling-site Scan");
  const end = body.indexOf("#### Skill Change Review", start + 1);
  if (start === -1 || end === -1) {
    throw new Error("#### Sibling-site Scan block not found");
  }
  return body.slice(start, end);
}

/** §5's end-to-end delivery paragraph, before the Sibling-site Scan. */
function deliveryRule(skill: string): string {
  const body = section5(skill);
  const start = body.indexOf("**End-to-end delivery is never");
  const end = body.indexOf("#### Sibling-site Scan", start + 1);
  if (start === -1 || end === -1) {
    throw new Error("end-to-end delivery rule not found in §5");
  }
  return body.slice(start, end);
}

describe("qa Sibling-site Scan searches the defect class (#1249 AC-3)", () => {
  it("asks for the defect class, not the symbol being changed", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      const scan = siblingScan(text);
      expect(scan, root).toContain("name the **defect class**");
      expect(scan, root).toContain("not for the symbol being changed");
      expect(scan, root).toContain(
        "every git call in the file without `-C <target>`",
      );
    }
  });

  it("makes the scan name the class it searched", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      expect(siblingScan(text), root).toContain(
        "starts with `Class searched: <class>`",
      );
      // The §5 output slot carries the class too.
      expect(section5(text), root).toContain(
        "- **Sibling sites considered:** [Class searched: <defect class>",
      );
    }
  });

  it("keeps the precheck's siblingGrep a symbol-level hint", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      const scan = siblingScan(text);
      expect(scan, root).toContain("`siblingGrep`");
      expect(scan, root).toContain("never as the class search");
      expect(scan, root).not.toContain("Don't automate via grep");
    }
  });
});

describe("qa Risk Assessment: end-to-end delivery is never 'Not tested' (#1249 AC-4)", () => {
  it("requires running the delivery path or marking the AC PENDING", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      const rule = deliveryRule(text);
      expect(rule, root).toContain("surfaces in the PR body");
      expect(rule, root).toContain("run that path");
      expect(rule, root).toContain("mark the AC `PENDING`");
      expect(rule, root).toContain("`NEEDS_VERIFICATION` via `pending_count`");
      expect(rule, root).toContain("do not mark it `MET`");
    }
  });

  it("no longer reserves NEEDS_VERIFICATION for external/temporal gates alone", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      expect(siblingScan(text), root).toContain(
        "and unrun end-to-end delivery",
      );
    }
  });
});
