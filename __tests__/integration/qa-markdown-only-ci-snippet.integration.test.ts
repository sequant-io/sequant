// Integration test for Issue #569 — verify the bash snippet documented in
// `.claude/skills/qa/SKILL.md` (Markdown-Only Diff Relaxation subsection)
// actually executes correctly when the model invokes it as a `/qa` reviewer.
//
// The unit tests in src/lib/qa/markdown-only-ci.test.ts cover the helper
// functions in isolation. This test covers the prompt-shell boundary: that the
// `npx tsx -e` invocation, env-var construction, JSON shape, and fallback path
// all behave as the SKILL.md documents. Without this test, SKILL.md edits that
// break shell quoting, change env-var names, or drift the JSON schema would
// only surface post-merge in production /qa runs.
//
// Run with: npx vitest run __tests__/integration/qa-markdown-only-ci-snippet.integration.test.ts

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// The bash invocation copy-pasted verbatim from `.claude/skills/qa/SKILL.md`
// (under "Markdown-Only Diff Relaxation > Procedure"). Keep this string in
// lockstep with the SKILL.md prose. If you edit one, edit the other; the
// `documents the same env-var names` assertion below catches missed pairs.
const SKILL_SNIPPET = `npx tsx -e '
  (async () => {
    const m = await import("./src/lib/qa/markdown-only-ci.ts");
    const { getSettings } = await import("./src/lib/settings.ts");
    const files = (process.env.SEQUANT_QA_RELAX_FILES || "").split("\\n").filter(Boolean);
    const pending = (process.env.SEQUANT_QA_RELAX_PENDING || "").split("\\n").filter(Boolean);
    const settings = await getSettings();
    const isMdOnly = m.detectMarkdownOnlyDiff(files);
    const enabled = settings.qa.markdownOnlyCiRelaxed && isMdOnly;
    const buckets = enabled
      ? m.filterRelaxablePending(pending, settings.qa.markdownOnlySafeCiPatterns)
      : { relaxed: [], gating: pending };
    console.log(JSON.stringify({ isMdOnly, enabled, ...buckets }));
  })();
'`;

interface SnippetOutput {
  isMdOnly: boolean;
  enabled: boolean;
  relaxed: string[];
  gating: string[];
}

function runSnippet(files: string[], pending: string[]): SnippetOutput {
  const stdout = execSync(SKILL_SNIPPET, {
    cwd: resolve(__dirname, "..", ".."),
    env: {
      ...process.env,
      SEQUANT_QA_RELAX_FILES: files.join("\n"),
      SEQUANT_QA_RELAX_PENDING: pending.join("\n"),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
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
      ["docs/foo.md", "src/lib/foo.ts"],
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

  it("documents the same env-var names that SKILL.md prose references", async () => {
    // Drift guard: the env-var names used by runSnippet() above must match
    // the ones documented in the SKILL.md procedure block. If a future edit
    // renames either side without the other, this assertion fails loudly.
    const fs = await import("node:fs/promises");
    const skillMd = await fs.readFile(
      resolve(__dirname, "..", "..", ".claude/skills/qa/SKILL.md"),
      "utf8",
    );
    expect(skillMd).toContain("SEQUANT_QA_RELAX_FILES");
    expect(skillMd).toContain("SEQUANT_QA_RELAX_PENDING");
    expect(skillMd).toContain("detectMarkdownOnlyDiff");
    expect(skillMd).toContain("filterRelaxablePending");
    expect(skillMd).toContain("markdownOnlyCiRelaxed");
    expect(skillMd).toContain("markdownOnlySafeCiPatterns");
  });
});
