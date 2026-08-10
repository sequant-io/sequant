/**
 * Spec citation grounding — unit tests (in-process only).
 *
 * Fixture inputs are **verbatim excerpts from real spec plan comments** in this
 * repository (#915, #920, #921), not synthetic chimeras: a hand-built fixture
 * that exercises every branch at once hides the false negatives real prose
 * produces (feedback_synthetic_test_fixture_trap.md, #551/#547). Two of the
 * cases below — the elided-prefix path and the proposed-alias symbol — are
 * regressions the synthetic version of this suite did not catch and the first
 * real corpus sample did.
 *
 * The CLI tests (`--help`, `--out`, stdin) live in
 * `ground-check-cli.integration.test.ts`: they spawn `npx tsx` subprocesses,
 * which belong in the `integration` project (serialized, 30 s floor), not here
 * under the unit project's 5 s default and parallel file execution (#842).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  stripFences,
  stripLineSuffix,
  extractCitations,
  isSymbolCandidate,
  candidatePaths,
  resolvePath,
  summarize,
  parseArgs,
  type RepoIndex,
} from "./ground-check.js";

// ---------------------------------------------------------------------------
// A stand-in repository index. Paths are real paths from this repo, so the
// resolution cases below mirror what the corpus actually contains.
// ---------------------------------------------------------------------------

function makeIndex(files: string[]): RepoIndex {
  const set = new Set(files);
  const dirs = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();
  for (const f of files) {
    const segments = f.split("/");
    const base = segments[segments.length - 1];
    byBasename.set(base, [...(byBasename.get(base) ?? []), f]);
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(i).join("/");
      bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), f]);
    }
    for (let i = 1; i < segments.length; i++) {
      dirs.add(segments.slice(0, i).join("/") + "/");
    }
  }
  return { files: set, dirs, byBasename, bySuffix };
}

const INDEX = makeIndex([
  "src/commands/ready.ts",
  "src/lib/workflow/batch-executor.ts",
  "src/lib/assess-collision-detect.ts",
  "scripts/qa/precheck.ts",
  ".claude/skills/qa/SKILL.md",
  "templates/skills/qa/SKILL.md",
  "skills/qa/SKILL.md",
  "bin/cli.ts",
  "package.json",
  "CHANGELOG.md",
]);

// ---------------------------------------------------------------------------
// stripFences
// ---------------------------------------------------------------------------

describe("stripFences", () => {
  it("drops fenced blocks but preserves line numbering", () => {
    const text = [
      "before",
      "```bash",
      "npx tsx scripts/nope.ts",
      "```",
      "after",
    ].join("\n");
    const out = stripFences(text).split("\n");
    expect(out).toHaveLength(5);
    expect(out[0]).toBe("before");
    expect(out[2]).toBe("");
    expect(out[4]).toBe("after");
  });

  it("keeps inline single-backtick spans, which is how real citations appear", () => {
    const text = "The gate lives in `scripts/qa/precheck.ts` today.";
    expect(stripFences(text)).toContain("`scripts/qa/precheck.ts`");
  });
});

// ---------------------------------------------------------------------------
// stripLineSuffix
// ---------------------------------------------------------------------------

describe("stripLineSuffix", () => {
  it.each([
    ["qa/SKILL.md:165", "qa/SKILL.md"],
    ["sync.ts:271-275", "sync.ts"],
    ["bin/cli.ts", "bin/cli.ts"],
  ])("%s -> %s", (input, expected) => {
    expect(stripLineSuffix(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// extractCitations
// ---------------------------------------------------------------------------

describe("extractCitations", () => {
  it("extracts a line-suffixed path citation verbatim", () => {
    // Verbatim from the #922 plan comment.
    const text =
      "`/qa` already documents that ad-hoc background agents hallucinate (`qa/SKILL.md:165`).";
    const cites = extractCitations(text);
    const raws = cites.map((c) => c.raw);
    expect(raws).toContain("qa/SKILL.md:165");
  });

  it("does not treat git and shell path idioms as directory citations", () => {
    // Verbatim shapes from the corpus: a remote, a branch namespace, and a
    // relative-path marker. Four of the 34 "asserted phantoms" in the first
    // full corpus run were this class.
    const text =
      "Rebase onto `origin/` and branch under `fix/`; run it from `./` or `../`.";
    expect(extractCitations(text)).toHaveLength(0);
  });

  it("does not treat slash-commands or labels as citations", () => {
    const text =
      "Add the `enhancement` label and run `/qa`; the `bug` path is out of scope.";
    expect(extractCitations(text)).toHaveLength(0);
  });

  it("extracts camelCase symbols but not lowercase prose words", () => {
    // Verbatim shape from the #915 plan comment.
    const text =
      "Resolve in both producers: `buildExecutionConfig` and `ready`.";
    const symbols = extractCitations(text)
      .filter((c) => c.kind === "symbol")
      .map((c) => c.raw);
    expect(symbols).toEqual(["buildExecutionConfig"]);
  });

  it("ignores backticked paths that appear only inside fenced blocks", () => {
    // The fence content is deliberately *backticked*. An unbackticked path in
    // a fence is not extractable in the first place, so asserting on one
    // passes even with fence-stripping disabled — that version of this test
    // was a tautology, caught by mutation-testing `stripFences`. Measured
    // across the 159-comment corpus a backticked path inside a fence occurs 0
    // times, so this fixture is constructed rather than captured: it gates the
    // specified behavior, and `stripFences`'s doc comment records that the
    // live value here is zero.
    const text = [
      "```md",
      "See `src/lib/does-not-exist.ts` for the details.",
      "```",
    ].join("\n");
    expect(extractCitations(text)).toHaveLength(0);
  });

  it("deduplicates repeated citations", () => {
    const text = "`bin/cli.ts` and again `bin/cli.ts`";
    expect(extractCitations(text)).toHaveLength(1);
  });

  it("marks creation intent when a creation verb precedes the citation", () => {
    const text = "Create `scripts/spec/ground-check.ts` that emits JSON.";
    expect(extractCitations(text)[0].intent).toBe("creation");
  });

  it("marks creation intent for the passive shape that dominates plan prose", () => {
    // Verbatim from the #915 plan comment — the verb follows the citation.
    const text = "`escalateEffort` added to `RunOptions` in `types.ts`";
    const cite = extractCitations(text).find((c) => c.raw === "escalateEffort");
    expect(cite?.intent).toBe("creation");
  });

  it("marks a proposed alias as creation, not as a claim about existing code", () => {
    // Verbatim from the #920 plan comment. Before `export|alias` were creation
    // verbs this scored as an asserted phantom, overstating the phantom rate.
    const text = "If naming grates, export an alias `hasDeliverableCommits`.";
    const cite = extractCitations(text).find(
      (c) => c.raw === "hasDeliverableCommits",
    );
    expect(cite?.intent).toBe("creation");
  });

  it("defaults to reference intent for a plain description", () => {
    const text =
      "The deterministic precheck lives in `scripts/qa/precheck.ts`.";
    expect(extractCitations(text)[0].intent).toBe("reference");
  });
});

// ---------------------------------------------------------------------------
// isSymbolCandidate
// ---------------------------------------------------------------------------

describe("isSymbolCandidate", () => {
  it.each([
    "buildExecutionConfig",
    "RunOptions",
    "DEFAULT_EFFORT",
    "waiting_for_human_merge",
  ])("accepts code-shaped token %s", (token) => {
    expect(isSymbolCandidate(token)).toBe(true);
  });

  it.each(["bug", "test", "enhancement", "main", "run", "qa", "no"])(
    "rejects prose/label token %s",
    (token) => {
      expect(isSymbolCandidate(token)).toBe(false);
    },
  );

  it("rejects a lowercase word with no code shape", () => {
    expect(isSymbolCandidate("phantom")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// candidatePaths + resolvePath
// ---------------------------------------------------------------------------

describe("candidatePaths", () => {
  it("expands a bare skill-mirror path to all three mirrors", () => {
    expect(candidatePaths("qa/SKILL.md")).toEqual([
      "qa/SKILL.md",
      ".claude/skills/qa/SKILL.md",
      "templates/skills/qa/SKILL.md",
      "skills/qa/SKILL.md",
    ]);
  });

  it("strips the line suffix before building candidates", () => {
    expect(candidatePaths("bin/cli.ts:208")[0]).toBe("bin/cli.ts");
  });
});

describe("resolvePath", () => {
  it("resolves an exact tracked path", () => {
    expect(resolvePath("bin/cli.ts", INDEX)).toEqual({
      exists: true,
      matchedAt: "bin/cli.ts",
    });
  });

  it("resolves a line-suffixed citation to the underlying file", () => {
    expect(resolvePath("qa/SKILL.md:165", INDEX).matchedAt).toBe(
      ".claude/skills/qa/SKILL.md",
    );
  });

  it("resolves an elided-prefix citation (regression: commands/ready.ts)", () => {
    // `commands/ready.ts` is really `src/commands/ready.ts`. This was scored
    // as a phantom until suffix resolution landed — found on the first real
    // corpus sample, never by the synthetic fixtures.
    expect(resolvePath("commands/ready.ts", INDEX)).toEqual({
      exists: true,
      matchedAt: "src/commands/ready.ts",
    });
  });

  it("resolves a bare filename by basename", () => {
    expect(resolvePath("batch-executor.ts", INDEX).matchedAt).toBe(
      "src/lib/workflow/batch-executor.ts",
    );
  });

  it("resolves a root-level file", () => {
    expect(resolvePath("package.json", INDEX).exists).toBe(true);
  });

  it("resolves a directory citation, including an elided prefix", () => {
    expect(resolvePath("src/lib/workflow/", INDEX).exists).toBe(true);
    expect(resolvePath("workflow/", INDEX).exists).toBe(true);
  });

  it("reports a genuinely absent path as missing", () => {
    expect(resolvePath("src/lib/does-not-exist.ts", INDEX)).toEqual({
      exists: false,
    });
  });

  it("resolves an untracked-but-real path when given a cwd", () => {
    // `dist/` and `.sequant/state.json` are gitignored build/runtime
    // artifacts that plans cite constantly. Six of the 34 "asserted phantoms"
    // in the first full corpus run were this class — instrument error
    // reported as a plan defect. Uses a real temp tree rather than the repo
    // so the assertion does not depend on whether `dist/` happens to be built.
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "ground-check-untracked-"),
    );
    fs.mkdirSync(path.join(tmp, "dist"));
    fs.writeFileSync(path.join(tmp, "dist", "cli.js"), "");
    try {
      expect(resolvePath("dist/", INDEX, tmp).exists).toBe(true);
      expect(resolvePath("dist/cli.js", INDEX, tmp).exists).toBe(true);
      expect(resolvePath("dist/nope.js", INDEX, tmp).exists).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not consult the filesystem when no cwd is supplied", () => {
    expect(resolvePath("dist/", INDEX).exists).toBe(false);
  });

  it("resolves a gitignored path that is absent from this checkout", () => {
    // The stronger of the two untracked signals. `fs.existsSync` alone makes
    // the measurement checkout-dependent: a fresh worktree has no `dist/` or
    // `.sequant/state.json`, so the same corpus scores paths as phantoms
    // there that a built checkout resolves. A path matched by a gitignore
    // rule is *expected* to be absent from the index, present or not.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ground-check-ignore-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\n.sequant/\n");
      // Deliberately do NOT create dist/ or .sequant/ — absent but ignored.
      expect(fs.existsSync(path.join(repo, "dist"))).toBe(false);

      expect(resolvePath("dist/", INDEX, repo).exists).toBe(true);
      expect(resolvePath(".sequant/state.json", INDEX, repo).exists).toBe(true);
      expect(
        resolvePath("src/lib/genuinely-absent.ts", INDEX, repo).exists,
      ).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("treats a repo-external path as out of scope, not as a phantom", () => {
    // `../worktrees/` is real but outside anything a ref can describe.
    // Comparison is on the resolved path, not a "..' substring, so a
    // re-entrant path like `a/../src/x.ts` is still judged on where it lands.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ground-check-ext-"));
    try {
      expect(resolvePath("../worktrees/", INDEX, repo).exists).toBe(true);
      expect(resolvePath("../elsewhere/thing.ts", INDEX, repo).exists).toBe(
        true,
      );
      // Re-entrant: resolves back inside the repo, so it is judged normally.
      expect(resolvePath("sub/../nope.ts", INDEX, repo).exists).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe("summarize", () => {
  it("counts missing citations separately by intent", () => {
    const summary = summarize([
      { raw: "a.ts", kind: "path", exists: true, line: 1, intent: "reference" },
      {
        raw: "b.ts",
        kind: "path",
        exists: false,
        line: 2,
        intent: "reference",
      },
      { raw: "c.ts", kind: "path", exists: false, line: 3, intent: "creation" },
      {
        raw: "fooBar",
        kind: "symbol",
        exists: true,
        line: 4,
        intent: "reference",
      },
    ]);
    expect(summary).toEqual({
      total: 4,
      paths: 3,
      symbols: 1,
      resolved: 2,
      missingReferenced: 1,
      missingCreation: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses the full flag set", () => {
    expect(
      parseArgs(["--in", "plan.md", "--ref", "abc123", "--out", "o.json"]),
    ).toEqual({ in: "plan.md", ref: "abc123", out: "o.json", help: false });
  });

  it("defaults to stdin and stdout", () => {
    expect(parseArgs([])).toEqual({
      in: null,
      ref: null,
      out: null,
      help: false,
    });
  });

  it("recognises --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});
