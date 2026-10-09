/**
 * Committed vs on-disk skills (#1354).
 *
 * `sequant run` provisions phase worktrees from git, so phases load the
 * skills committed at `HEAD`, not the ones on disk in the main checkout. A
 * `sequant sync` that was never committed therefore never reaches a run, and
 * the version-marker check (`areSkillsOutdated`) reads the on-disk
 * `.sequant-version`, so it names a version the phases don't use. Observed
 * downstream: the warning said 2.18.0 while every phase ran the committed
 * 2.15.1 skills.
 *
 * This module reads what git sees: tracked files under `.claude/skills/` with
 * uncommitted changes, and the `.sequant-version` at `HEAD`. `doctor`, the run
 * pre-flight and `sync`/`update` all format their warning from it, so the
 * three cannot drift. Untracked skills are #1257's check (`doctor`); this one
 * covers tracked-but-modified.
 */

import { spawnSync } from "child_process";

export const SKILLS_DIR_PATH = ".claude/skills";
const VERSION_MARKER = `${SKILLS_DIR_PATH}/.sequant-version`;

export interface SkillsCommitState {
  /** `.sequant-version` at `HEAD`, or null when not committed / not a repo. */
  committedVersion: string | null;
  /** Tracked paths under `.claude/skills/` with uncommitted changes. */
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
 * The shared warning, or null when every tracked skill is committed. Names
 * the committed version, because that is what phases will run.
 */
export function formatSkillsCommitWarning(
  state: SkillsCommitState,
): string | null {
  if (state.modified.length === 0) return null;
  const count = state.modified.length;
  const files = `${count} tracked file${count === 1 ? "" : "s"} under ${SKILLS_DIR_PATH}/ ${count === 1 ? "has" : "have"} uncommitted changes`;
  const uses = state.committedVersion
    ? `phases will use the committed skills (${state.committedVersion})`
    : "phases will use the committed skills";
  return (
    `${files}; sequant run checks phase worktrees out from git, so ${uses}, not the ones on disk. ` +
    `Commit ${SKILLS_DIR_PATH}/ (and .sequant-manifest.json) before running.`
  );
}
