/**
 * Skill-text gates for the explicit in-place checkout mode (#1136).
 *
 * `SEQUANT_CHECKOUT=in-place` runs a phase on a feature branch in the current
 * clone, for checkouts that have no worktree (a claude.ai cloud session). The
 * claims locked down here live only in prose:
 *
 *   - `/exec` creates `feature/<N>-<slug>` in the clone and never reaches the
 *     worktree machinery (AC-1).
 *   - `/qa` (and `/loop`, `/testgen`, which also resolve a worktree) treat
 *     `$PWD` as the worktree and halt on the base branch (AC-2).
 *   - The mode is never inferred: every mention of the flag sits inside a
 *     delimited in-place region, so the #899 guards read exactly as before
 *     when it is unset (AC-3).
 *
 * Per CLAUDE.md, assertions are scoped to the delimited regions
 * (`<!-- BEGIN: in-place-checkout… -->` / `<!-- END: in-place-checkout… -->`),
 * never the whole file. Where the region carries a bash block, the block is
 * also *executed* in a scratch clone, and the result is judged by sequant's own
 * worktree resolver and verifier — the same code the #899 guards run.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { collectFiles } from "../../scripts/check-skill-sync.js";
import { listWorktrees } from "../../src/lib/workflow/worktree-manager.js";
import {
  resolveIssueWorktree,
  verifyWorktreePath,
} from "../../src/lib/workflow/worktree-resolver.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

const SKILL_ROOTS = [".claude/skills", "templates/skills", "skills"] as const;

/** Skills besides /exec that locate a worktree and so need the in-place entry. */
const RESOLVING_SKILLS = ["qa", "loop", "testgen"] as const;

const MAIN_REGION = "in-place-checkout (#1136)";

/** The worktree machinery in-place mode must never invoke. */
const WORKTREE_CALLS = [
  "new-feature.sh",
  "git worktree add",
  "sequant worktree resolve",
] as const;

function readSkill(root: string, skill: string): string {
  const file = path.join(REPO_ROOT, root, skill, "SKILL.md");
  if (!existsSync(file)) throw new Error(`Missing skill file: ${file}`);
  return readFileSync(file, "utf8");
}

function allSkills(root: string): string[] {
  const dir = path.join(REPO_ROOT, root);
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        existsSync(path.join(dir, e.name, "SKILL.md")),
    )
    .map((e) => e.name)
    .sort();
}

interface Region {
  name: string;
  start: number;
  end: number;
  body: string;
}

/**
 * Every `<!-- BEGIN: in-place-checkout… -->` … `<!-- END: <same name> -->`
 * region in the file, with its character offsets. An unmatched BEGIN throws,
 * so deleting an END marker fails loudly rather than widening a region.
 */
function inPlaceRegions(content: string): Region[] {
  const regions: Region[] = [];
  const begin = /<!-- BEGIN: (in-place-checkout[^>]*?) -->/g;
  for (let m = begin.exec(content); m !== null; m = begin.exec(content)) {
    const name = m[1];
    const endMarker = `<!-- END: ${name} -->`;
    const end = content.indexOf(endMarker, m.index);
    if (end === -1) throw new Error(`Region "${name}" has no END marker`);
    regions.push({
      name,
      start: m.index,
      end: end + endMarker.length,
      body: content.slice(m.index, end),
    });
  }
  return regions;
}

/** The named region, throwing when it is absent. */
function region(content: string, name: string): Region {
  const found = inPlaceRegions(content).find((r) => r.name === name);
  if (!found) throw new Error(`Region "${name}" not found`);
  return found;
}

/** Concatenated bodies of every fenced code block in `text`. */
function codeBlocks(text: string): string {
  return [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join("\n");
}

/** `text` with its fenced code blocks removed, leaving the prose. */
function prose(text: string): string {
  return text.replace(/```[a-z]*\n[\s\S]*?```/g, "");
}

// ---------------------------------------------------------------------------
// Scratch-clone harness: run a region's bash block for real.
// ---------------------------------------------------------------------------

const ISSUE = 1136;
const TITLE = "Explicit in-place checkout: mode (for cloud sessions)";
const EXPECTED_BRANCH =
  "feature/1136-explicit-in-place-checkout-mode-for-cloud-sessions".slice(0, 58);

const SCRATCH = mkdtempSync(path.join(tmpdir(), "in-place-1136-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
let scratchCount = 0;

/** Hermetic git: no global config (gpg signing, hooks), fixed identity. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

interface Scratch {
  clone: string;
  /** Every argv the `npx` shim received, one per line. */
  npxLog: string;
  env: Record<string, string>;
}

/**
 * A fresh clone of a one-commit `main`, as a cloud session starts. `gh` is
 * shimmed to print a fixed issue title; `npx` is shimmed to log its argv and
 * fail, so any `npx sequant worktree …` call is both recorded and fatal.
 * Every `SEQUANT_*` var is scrubbed from the inherited env (#1086).
 */
function scratchClone(): Scratch {
  const root = path.join(SCRATCH, String(scratchCount++));
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "clone");
  const clone = path.join(root, "clone");
  git(clone, "checkout", "-q", "-B", "main");
  git(clone, "commit", "-q", "--allow-empty", "-m", "init");
  git(clone, "push", "-q", "origin", "main");

  const npxLog = path.join(root, "npx.log");
  writeFileSync(npxLog, "");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\necho ${JSON.stringify(TITLE)}\n`,
  );
  writeFileSync(
    path.join(bin, "npx"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(npxLog)}\nexit 97\n`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  chmodSync(path.join(bin, "npx"), 0o755);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SEQUANT_")) env[k] = v;
  }
  Object.assign(env, GIT_ENV, { PATH: `${bin}:${process.env.PATH}` });
  return { clone, npxLog, env };
}

/** The single bash block of a skill's main in-place region, for `ISSUE`. */
function entryBlock(root: string, skill: string): string {
  const blocks = [
    ...region(readSkill(root, skill), MAIN_REGION).body.matchAll(
      /```bash\n([\s\S]*?)```/g,
    ),
  ];
  expect(blocks.length).toBe(1);
  return blocks[0][1].split("<issue-number>").join(String(ISSUE));
}

/** Run a skill's entry block in the scratch clone; report exit, output, branch. */
function runEntry(
  s: Scratch,
  root: string,
  skill: string,
  flags: Record<string, string>,
): { status: number | null; out: string; branch: string } {
  const r = spawnSync(
    "bash",
    ["-c", `${entryBlock(root, skill)}\necho "WORKTREE=\${WORKTREE:-}"`],
    { cwd: s.clone, encoding: "utf8", env: { ...s.env, ...flags } },
  );
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    branch: git(s.clone, "branch", "--show-current"),
  };
}

describe.each(SKILL_ROOTS)("in-place checkout mode in %s", (root) => {
  describe("exec", () => {
    it("creates feature/<N>-<slug> from origin/<base> when on the base branch (AC-1)", () => {
      const code = codeBlocks(region(readSkill(root, "exec"), MAIN_REGION).body);

      // Entered only by the explicit flag.
      expect(code).toContain('"${SEQUANT_CHECKOUT:-}" == "in-place"');
      // On the base branch (or detached), branch from the remote base.
      expect(code).toContain('"$CURRENT" == "$BASE"');
      expect(code).toContain("feature/<issue-number>-${SLUG}");
      expect(code).toContain('git checkout -b "$BRANCH" "origin/$BASE"');

      // Run it: a fresh clone on main ends on the new-feature.sh branch name,
      // and sequant's own resolver maps that checkout to the issue.
      const s = scratchClone();
      const run = runEntry(s, root, "exec", { SEQUANT_CHECKOUT: "in-place" });
      expect(run.status, run.out).toBe(0);
      expect(run.branch).toBe(EXPECTED_BRANCH);
      expect(git(s.clone, "merge-base", "HEAD", "origin/main")).toBe(
        git(s.clone, "rev-parse", "origin/main"),
      );
      const resolved = resolveIssueWorktree(ISSUE, s.clone);
      expect(resolved.ok && resolved.branch).toBe(EXPECTED_BRANCH);

      // Already on a non-base branch: kept, no second branch.
      const again = runEntry(s, root, "exec", { SEQUANT_CHECKOUT: "in-place" });
      expect(again.status, again.out).toBe(0);
      expect(git(s.clone, "branch", "--list").split("\n")).toHaveLength(2);
    });

    it("never invokes new-feature.sh, git worktree add, or worktree resolve (AC-1)", () => {
      const body = region(readSkill(root, "exec"), MAIN_REGION).body;

      const code = codeBlocks(body);
      for (const call of WORKTREE_CALLS) {
        expect(code).not.toContain(call);
      }
      // In prose they may appear only inside the prohibition.
      const text = prose(body);
      const mentions = text
        .split("\n")
        .filter((line) => WORKTREE_CALLS.some((c) => line.includes(c)));
      expect(mentions.length).toBeGreaterThan(0);
      expect(text).toMatch(
        /\*\*Never\*\* run `\.\/scripts\/new-feature\.sh`[\s\S]*never run `git worktree add`[\s\S]*never run `npx sequant worktree resolve`/,
      );

      // Run it: no worktree appears and `npx` is never reached.
      const s = scratchClone();
      const run = runEntry(s, root, "exec", { SEQUANT_CHECKOUT: "in-place" });
      expect(run.status, run.out).toBe(0);
      expect(listWorktrees(s.clone)).toHaveLength(1);
      expect(readFileSync(s.npxLog, "utf8")).toBe("");
    });

    it("skips the dev-server smoke test unless SEQUANT_SMOKE=1 and never invokes /test (AC-1)", () => {
      const content = readSkill(root, "exec");
      const main = region(content, MAIN_REGION).body;
      const smoke = region(content, "in-place-checkout-skip: smoke-test (#1136)");

      expect(main).toContain("**Never invoke `/test`.**");
      expect(smoke.body).toMatch(/skip this section unless\s+`SEQUANT_SMOKE=1`/);
      // The marker must precede the dev-server command it skips.
      expect(smoke.start).toBeLessThan(content.indexOf("npm run dev &"));
    });

    it("marks each worktree-creating site as skipped, ahead of the call (AC-1)", () => {
      const content = readSkill(root, "exec");

      const gathering = region(
        content,
        "in-place-checkout-skip: context-gathering (#1136)",
      );
      expect(gathering.start).toBeLessThan(
        content.indexOf("./scripts/new-feature.sh <issue-number> &"),
      );

      const workflow = region(
        content,
        "in-place-checkout-skip: worktree-workflow (#1136)",
      );
      expect(workflow.body).toContain("skip this whole section");
      // Ahead of the main-branch safeguard, the #899 guard and the lookup.
      for (const later of [
        "**CRITICAL: Main Branch Safeguard",
        "<!-- BEGIN: worktree-existence-guard (#899) -->",
        "<!-- BEGIN: worktree-standalone-lookup (#899) -->",
      ]) {
        const at = content.indexOf(later);
        expect(at).toBeGreaterThan(-1);
        expect(workflow.end).toBeLessThan(at);
      }
    });
  });

  describe.each(RESOLVING_SKILLS)("%s", (skill) => {
    it("treats $PWD as the worktree and halts on the base branch (AC-2)", () => {
      const content = readSkill(root, skill);
      const main = region(content, MAIN_REGION);
      const code = codeBlocks(main.body);

      expect(code).toContain('WORKTREE="$PWD"');
      // The base-branch halt: the branch test is followed directly by exit 1,
      // and nothing but the flag check encloses it.
      expect(code).toMatch(
        /if \[\[ -z "\$CURRENT" \|\| "\$CURRENT" == "\$BASE" \]\]; then\n\s+echo "❌ HALT:[^\n]*"\n\s+exit 1/,
      );
      expect(code).not.toMatch(/git (checkout -b|switch -c)/);
      for (const call of WORKTREE_CALLS) {
        expect(code).not.toContain(call);
      }

      // It must run before either #899 path could resolve a worktree.
      const lookup = content.indexOf(
        "<!-- BEGIN: worktree-standalone-lookup (#899) -->",
      );
      expect(lookup).toBeGreaterThan(-1);
      expect(main.end).toBeLessThan(lookup);
      const guard = content.indexOf(
        "<!-- BEGIN: worktree-existence-guard (#899) -->",
      );
      if (guard !== -1) expect(main.end).toBeLessThan(guard);

      // Run it. On the base branch: halt. On a detached HEAD: halt.
      const s = scratchClone();
      const onBase = runEntry(s, root, skill, { SEQUANT_CHECKOUT: "in-place" });
      expect(onBase.status).toBe(1);
      expect(onBase.out).toContain("HALT");
      expect(onBase.out).not.toContain("WORKTREE=");

      // On the issue's branch: $PWD is adopted, and it is a checkout the #899
      // verifier accepts for this issue — without qa itself calling it.
      git(s.clone, "checkout", "-q", "-b", EXPECTED_BRANCH);
      const onFeature = runEntry(s, root, skill, {
        SEQUANT_CHECKOUT: "in-place",
      });
      expect(onFeature.status, onFeature.out).toBe(0);
      const adopted = /WORKTREE=(.*)/.exec(onFeature.out)?.[1] ?? "";
      const verified = verifyWorktreePath(adopted, { issue: ISSUE, cwd: s.clone });
      expect(verified.ok && verified.branch).toBe(EXPECTED_BRANCH);
      expect(readFileSync(s.npxLog, "utf8")).toBe("");
      expect(onFeature.branch).toBe(EXPECTED_BRANCH);

      git(s.clone, "checkout", "-q", "--detach");
      const detached = runEntry(s, root, skill, { SEQUANT_CHECKOUT: "in-place" });
      expect(detached.status).toBe(1);
    });
  });

  describe("qa", () => {
    it("skips worktree resolve in the implementation status check (AC-2)", () => {
      const content = readSkill(root, "qa");
      const skip = region(content, "in-place-checkout-skip: status-check (#1136)");

      expect(skip.body).toContain('worktree_path="$PWD"');
      const call = content.indexOf(
        'worktree_path=$(npx sequant worktree resolve "<issue-number>"',
      );
      expect(call).toBeGreaterThan(-1);
      expect(skip.end).toBeLessThan(call);
    });
  });

  describe("never inferred", () => {
    it("every mention of the flag sits inside a delimited in-place region (AC-3)", () => {
      const offenders: string[] = [];
      let mentions = 0;

      // Every mirrored file under the root, not only SKILL.md: a reference
      // page that mentions the flag outside a region would count too.
      const files = collectFiles(path.join(REPO_ROOT, root));
      expect(files.length).toBeGreaterThan(allSkills(root).length);
      for (const rel of files.filter((f) => f.endsWith(".md"))) {
        const content = readFileSync(path.join(REPO_ROOT, root, rel), "utf8");
        const regions = inPlaceRegions(content);
        const flag = /SEQUANT_CHECKOUT|in-place/g;
        for (let m = flag.exec(content); m !== null; m = flag.exec(content)) {
          mentions++;
          const at = m.index;
          if (!regions.some((r) => at >= r.start && at < r.end)) {
            const line = content.slice(0, at).split("\n").length;
            offenders.push(`${rel}:${line}: ${m[0]}`);
          }
        }
      }

      // Guard against a vacuous pass if the flag were renamed everywhere.
      expect(mentions).toBeGreaterThan(0);
      expect(offenders).toEqual([]);
    });

    it("states that the mode is never inferred from git state (AC-3)", () => {
      for (const skill of ["exec", ...RESOLVING_SKILLS]) {
        const body = region(readSkill(root, skill), MAIN_REGION).body;
        expect(body).toMatch(/never\s+inferred\s+from\s+git\s+state/);
      }
    });

    it("is a no-op with the flag unset, even in a fresh clone on main (AC-3)", () => {
      // Exactly the state a cloud session starts in, and exactly the state
      // an inferring skill would mistake for in-place.
      const s = scratchClone();
      for (const skill of ["exec", ...RESOLVING_SKILLS]) {
        const run = runEntry(s, root, skill, {});
        expect(run.status, `${skill}: ${run.out}`).toBe(0);
        expect(run.branch).toBe("main");
        expect(run.out).toBe("WORKTREE=\n");
      }
      expect(listWorktrees(s.clone).map((w) => w.branch)).toEqual(["main"]);
      expect(readFileSync(s.npxLog, "utf8")).toBe("");
    });

    it("halts on an unrecognized value or alongside SEQUANT_WORKTREE", () => {
      const s = scratchClone();
      for (const skill of ["exec", ...RESOLVING_SKILLS]) {
        for (const flags of [
          { SEQUANT_CHECKOUT: "inplace" },
          { SEQUANT_CHECKOUT: "in-place", SEQUANT_WORKTREE: s.clone },
        ]) {
          const run = runEntry(s, root, skill, flags);
          expect(run.status, `${skill} ${JSON.stringify(flags)}`).toBe(1);
          expect(run.out).toContain("HALT");
        }
      }
      expect(resolveIssueWorktree(ISSUE, s.clone).ok).toBe(false);
    });
  });
});

describe("checkout modes reference page (AC-5)", () => {
  it("lists the three modes with entry condition and what each skips", () => {
    const file = path.join(REPO_ROOT, "docs/reference/checkout-modes.md");
    const table = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("|"));

    for (const mode of ["orchestrated", "standalone", "in-place"]) {
      const row = table.find((line) => line.startsWith(`| ${mode} `));
      expect(row, `row for ${mode}`).toBeDefined();
      // Mode, entry condition, where the work happens, what it skips.
      expect(row!.split("|").filter((c) => c.trim()).length).toBe(4);
    }
    expect(table[0]).toMatch(/Entry condition/);
    expect(table[0]).toMatch(/skips/i);
  });
});
