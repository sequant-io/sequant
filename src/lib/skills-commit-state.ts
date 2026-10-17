/**
 * Committed vs on-disk skills (#1354) and hooks (#1456).
 *
 * `sequant run` provisions phase worktrees from git, so phases load the
 * skills committed at `HEAD`, not the ones on disk in the main checkout. A
 * `sequant sync` that was never committed therefore never reaches a run, and
 * the version-marker check (`areSkillsOutdated`) reads the on-disk
 * `.sequant-version`, so it names a version the phases don't use. Observed
 * downstream: the warning said 2.18.0 while every phase ran the committed
 * 2.15.1 skills.
 *
 * Hooks load the same way, from `.claude/hooks/` at `HEAD` (#1456).
 *
 * This module reads what git sees: tracked files under `.claude/skills/` or
 * `.claude/hooks/` with uncommitted changes, and the `.sequant-version` at
 * `HEAD`. `doctor`, the run
 * pre-flight and `sync`/`update` all format their warning from it, so the
 * three cannot drift. Untracked skills are #1257's check (`doctor`); this one
 * covers tracked-but-modified.
 */

import { spawnSync } from "child_process";

export const SKILLS_DIR_PATH = ".claude/skills";
/** Hooks load from the committed tree too (#1456), so they get the same check. */
export const HOOKS_DIR_PATH = ".claude/hooks";
const VERSION_MARKER = `${SKILLS_DIR_PATH}/.sequant-version`;

export interface SkillsCommitState {
  /** `.sequant-version` at `HEAD`, or null when not committed / not a repo. */
  committedVersion: string | null;
  /** Tracked paths under `.claude/skills/` or `.claude/hooks/` with uncommitted changes. */
  modified: string[];
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout.toString();
}

/**
 * Read the skills commit state of the git checkout at `cwd`. Returns no
 * modifications (and a null version) outside a git repository, so callers
 * stay silent there.
 */
export function getSkillsCommitState(cwd: string): SkillsCommitState {
  const status = git(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--",
    SKILLS_DIR_PATH,
    HOOKS_DIR_PATH,
  ]);
  const modified = (status ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
  const committed = git(cwd, ["show", `HEAD:${VERSION_MARKER}`]);
  return {
    committedVersion: committed?.trim() || null,
    modified,
  };
}

/**
 * The shared warning, or null when every tracked skill and hook is committed.
 * Names the directory of each modified file, and the committed skills version
 * because that is what phases will run.
 */
export function formatSkillsCommitWarning(
  state: SkillsCommitState,
): string | null {
  if (state.modified.length === 0) return null;
  const inDir = (dir: string) =>
    state.modified.filter((p) => p.startsWith(`${dir}/`)).length;
  const skills = inDir(SKILLS_DIR_PATH);
  const hooks = inDir(HOOKS_DIR_PATH);
  const clause = (count: number, dir: string) =>
    `${count} tracked file${count === 1 ? "" : "s"} under ${dir}/ ${count === 1 ? "has" : "have"} uncommitted changes`;
  const clauses: string[] = [];
  const uses: string[] = [];
  const commit: string[] = [];
  if (skills > 0 || hooks === 0) {
    clauses.push(clause(skills || state.modified.length, SKILLS_DIR_PATH));
    uses.push(
      state.committedVersion
        ? `the committed skills (${state.committedVersion})`
        : "the committed skills",
    );
    commit.push(`${SKILLS_DIR_PATH}/ (and .sequant-manifest.json)`);
  }
  if (hooks > 0) {
    clauses.push(clause(hooks, HOOKS_DIR_PATH));
    uses.push("the committed hooks");
    commit.push(`${HOOKS_DIR_PATH}/`);
  }
  return (
    `${clauses.join("; ")}; sequant run checks phase worktrees out from git, so phases will use ${uses.join(" and ")}, not the ones on disk. ` +
    `Commit ${commit.join(" and ")} before running.`
  );
}
