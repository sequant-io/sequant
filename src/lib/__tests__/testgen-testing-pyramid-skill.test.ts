/**
 * CI gate for `/testgen`'s testing-pyramid reference (#1135, AC-6).
 *
 * `testgen/references/testing-pyramid.md` carries the unit / integration /
 * e2e split and per-component-type guidance adapted from the native
 * `engineering:testing-strategy` rubric, and `testgen/SKILL.md` must consult
 * it when the spec's verification section names no test level. Prose with no
 * runtime twin, so assertions run against the skill text, scoped per
 * CLAUDE.md to `### Step 2: Parse Verification Criteria` (up to
 * `### Step 2.1`) and to the reference's own sections. All three skill copies
 * are checked.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  collectFiles,
  SKILL_ROOTS,
} from "../../../scripts/check-skill-sync.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const REFERENCE = "testgen/references/testing-pyramid.md";

/** Read `rel` from each skill root via the `lint:skill-sync` walker. */
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

describe("testgen testing-pyramid reference (AC-6)", () => {
  it("reference defines the unit / integration / e2e split", () => {
    for (const { root, text } of readFromEachRoot(REFERENCE)) {
      const pyramid = span(
        text,
        "## The pyramid",
        "## Level by component type",
      );
      for (const level of ["**Unit**", "**Integration**", "**E2E**"]) {
        expect(pyramid, `${root}: ${level}`).toContain(level);
      }
    }
  });

  it("reference gives per-component-type guidance", () => {
    for (const { root, text } of readFromEachRoot(REFERENCE)) {
      const table = span(
        text,
        "## Level by component type",
        "## What to cover",
      );
      for (const component of [
        "**API endpoint**",
        "**CLI command**",
        "**Data pipeline**",
        "**Frontend**",
        "**Infrastructure / scripts**",
      ]) {
        expect(table, `${root}: ${component}`).toContain(component);
      }
    }
  });

  it("testgen/SKILL.md Step 2 consults it when the spec names no test level", () => {
    for (const { root, text } of readFromEachRoot("testgen/SKILL.md")) {
      const step2 = span(
        text,
        "### Step 2: Parse Verification Criteria",
        "### Step 2.1",
      );
      expect(step2, root).toContain(
        "When the spec's verification section names no test level",
      );
      expect(step2, root).toContain(
        "[testing-pyramid.md](references/testing-pyramid.md)",
      );
    }
  });
});
