/**
 * Gate test for #1276: /qa §6i builds the "diff test files" list from a
 * `git diff --name-only | grep -E '…'` command. A gate test that is a CI
 * workflow step must survive that filter, or its marker can never classify
 * `valid`. The filter is extracted from §6i's own bash block (not the whole
 * file) and run through grep against sample `--name-only` output.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  classifyMutationMarker,
  type MutationMarker,
} from "./mutation-marker.js";
import { SKILL_ROOTS } from "../../../scripts/check-skill-sync.js";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SKILL_COPIES = SKILL_ROOTS;

/** The text of §6i, from its heading to the next `###` heading. */
function section6i(copy: string): string {
  const text = readFileSync(join(REPO_ROOT, copy, "qa/SKILL.md"), "utf8");
  const start = text.indexOf("### 6i.");
  const end = text.indexOf("\n### ", start + 1);
  return text.slice(start, end);
}

/** The ERE §6i pipes `git diff --name-only` through. */
function diffFilterPattern(copy: string): string {
  const line = section6i(copy)
    .split("\n")
    .find((l) => l.includes("--diff-filter=AM --name-only"));
  const match = line?.match(/grep -E '([^']*)'/);
  if (!match) throw new Error(`no diff-file grep in §6i of ${copy}`);
  return match[1];
}

function applyFilter(pattern: string, names: string[]): string[] {
  const result = spawnSync("grep", ["-E", pattern], {
    input: names.join("\n") + "\n",
    encoding: "utf8",
  });
  return result.stdout.split("\n").filter(Boolean);
}

const NAME_ONLY = [
  ".github/workflows/plugin-install-test.yml",
  ".github/workflows/ci.yaml",
  ".github/workflows/sub/nested.yml",
  ".github/dependabot.yml",
  "docs/example.yml",
  "src/lib/foo.test.ts",
  "src/lib/foo.ts",
];

const marker = (failedTest: string): MutationMarker => ({
  ac: "AC-1",
  mutation: "removed the step",
  failedTest,
});

describe("/qa §6i diff-file list (#1276)", () => {
  for (const copy of SKILL_COPIES) {
    describe(copy, () => {
      it("keeps changed workflow files and test files, drops the rest", () => {
        const list = applyFilter(diffFilterPattern(copy), NAME_ONLY);
        expect(list).toEqual([
          ".github/workflows/plugin-install-test.yml",
          ".github/workflows/ci.yaml",
          ".github/workflows/sub/nested.yml",
          "src/lib/foo.test.ts",
        ]);
      });

      it("classifies a workflow-step marker valid when the file is in the list", () => {
        const list = applyFilter(diffFilterPattern(copy), NAME_ONLY);
        const m = marker(
          ".github/workflows/plugin-install-test.yml > install > README step",
        );
        expect(classifyMutationMarker(m, list)).toBe("valid");
      });

      it("classifies a workflow-step marker test_not_in_diff when the file is absent", () => {
        const list = applyFilter(
          diffFilterPattern(copy),
          NAME_ONLY.filter((n) => !n.includes("plugin-install-test")),
        );
        const m = marker(
          ".github/workflows/plugin-install-test.yml > install > README step",
        );
        expect(classifyMutationMarker(m, list)).toBe("test_not_in_diff");
      });
    });
  }
});
