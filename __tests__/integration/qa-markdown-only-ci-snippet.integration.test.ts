// Integration test for Issue #569 — runs the Markdown-Only Diff Relaxation
// procedure fence from `.claude/skills/qa/SKILL.md` itself (#1512), the way a
// `/qa` reviewer does: in a repo whose `git diff origin/main...HEAD` is the
// changed-file list, with the pending check names in `$pending_check_names`.
//
// The unit tests in src/lib/qa/markdown-only-ci.test.ts cover the helper
// functions in isolation. This test covers the prompt-shell boundary: that the
// `npx tsx -e` invocation, env-var construction, JSON shape, and fallback path
// all behave as the SKILL.md documents. A broken snippet takes the fence's own
// `|| echo` fallback, which reports `enabled: false` and fails the md-only
// cases below.
//
// Run with: npx vitest run __tests__/integration/qa-markdown-only-ci-snippet.integration.test.ts

import { afterAll, describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeDiffRepo,
  REPO_ROOT,
  skillEnv,
  skillFence,
} from "../helpers/skill-fence.js";

const repos: string[] = [];
afterAll(() => {
  for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
});

interface SnippetOutput {
  isMdOnly: boolean;
  enabled: boolean;
  relaxed: string[];
  gating: string[];
}

function runSnippet(files: string[], pending: string[]): SnippetOutput {
  const dir = makeDiffRepo(Object.fromEntries(files.map((f) => [f, "x\n"])));
  repos.push(dir);
  // The fence imports ./src/lib/... from its cwd; link this checkout's src
  // in, untracked so it stays out of the diff.
  fs.symlinkSync(path.join(REPO_ROOT, "src"), path.join(dir, "src"));
  const fence = skillFence("qa", {
    section: "#### Markdown-Only Diff Relaxation",
    contains: "SEQUANT_QA_RELAX_FILES",
  });
  const stdout = execSync(`${fence}\nprintf '%s' "$result"`, {
    cwd: dir,
    env: skillEnv({ pending_check_names: pending.join("\n") }),
    encoding: "utf8",
    shell: "/bin/bash",
  });
  return JSON.parse(stdout.trim());
}

describe("SKILL.md /qa markdown-only relaxation snippet (integration)", () => {
  it("md-only diff with mixed pending checks: relaxes safe-pattern matches, keeps others gating", () => {
    const out = runSnippet(
      [
        "docs/foo.md",
        "CHANGELOG.md",
        ".claude/skills/qa/SKILL.md",
        "skills/qa/SKILL.md",
      ],
      [
        "build (20.x)",
        "build (22.x)",
        "Plugin Structure Validation",
        "validate-skills",
      ],
    );

    expect(out.isMdOnly).toBe(true);
    expect(out.enabled).toBe(true);
    expect(out.relaxed).toEqual([
      "build (20.x)",
      "build (22.x)",
      "Plugin Structure Validation",
    ]);
    expect(out.gating).toEqual(["validate-skills"]);
  });

  it("mixed diff (.ts file present): relaxation disabled, all pending gates", () => {
    const out = runSnippet(
      ["docs/foo.md", "lib/foo.ts"],
      ["build (20.x)", "validate-skills"],
    );

    expect(out.isMdOnly).toBe(false);
    expect(out.enabled).toBe(false);
    expect(out.relaxed).toEqual([]);
    expect(out.gating).toEqual(["build (20.x)", "validate-skills"]);
  });

  it("empty pending list: no buckets to fill", () => {
    const out = runSnippet(["docs/foo.md"], []);

    expect(out.isMdOnly).toBe(true);
    expect(out.enabled).toBe(true);
    expect(out.relaxed).toEqual([]);
    expect(out.gating).toEqual([]);
  });
});
