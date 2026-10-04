// Tests for Issue #1199 — quality-checks.sh finds the main repo from a linked
// worktree at a custom root.
//
// verify_build_against_main() used to decide "am I in a worktree?" by matching
// `*"/worktrees/"*` against the cwd, so a worktree under a configured root
// (run.worktreeRoot / SEQUANT_WORKTREE_ROOT) re-ran the comparison build in the
// feature worktree itself. It now compares `git rev-parse --git-dir` with
// `--git-common-dir`. The function is extracted from each mirrored copy of the
// script and run from a worktree whose path has no `worktrees` segment, with
// `npm` stubbed to record the directory the comparison build runs in.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_ROOTS } from "../scripts/check-skill-sync.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const COPIES: Array<[label: string, path: string]> = SKILL_ROOTS.map(
  (root) => `${root}/qa/scripts/quality-checks.sh`,
).map((rel) => [rel, join(REPO_ROOT, rel)]);

let sandbox: string;
let main: string;
let linked: string;
let stubBin: string;
let record: string;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** Run verify_build_against_main from <cwd>; return the dir `npm` ran in. */
function buildDirFrom(scriptPath: string, cwd: string): string {
  rmSync(record, { force: true });
  const r = spawnSync(
    "bash",
    [
      "-c",
      `eval "$(sed -n '/^verify_build_against_main() {/,/^}/p' "$1")"
verify_build_against_main 1 "Error: feature"`,
      "bash",
      scriptPath,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
    },
  );
  expect(r.stdout).toContain("Running build on main branch");
  return readFileSync(record, "utf8").trim();
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "qc-1199-")));
  main = join(sandbox, "repo");
  linked = join(sandbox, "custom-root", "issue-1199");
  stubBin = join(sandbox, "bin");
  record = join(sandbox, "npm-cwd.txt");
  mkdirSync(main, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(
    join(stubBin, "npm"),
    `#!/bin/bash\npwd -P > ${JSON.stringify(record)}\nexit 0\n`,
    { mode: 0o755 },
  );
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@example.com");
  git(main, "config", "user.name", "t");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "feature/1199-x", linked);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe.each(COPIES)(
  "quality-checks.sh verify_build_against_main worktree detection (#1199) [%s]",
  (_label, scriptPath) => {
    it("builds in the main repo when run from a linked worktree at a custom root", () => {
      expect(buildDirFrom(scriptPath, linked)).toBe(main);
    });

    it("builds in place when run from the main checkout", () => {
      expect(buildDirFrom(scriptPath, main)).toBe(main);
    });
  },
);
