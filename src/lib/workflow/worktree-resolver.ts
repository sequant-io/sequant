/**
 * Repo-scoped worktree resolution and verification (#899).
 *
 * Skill-driven `/fullsolve` used to hand `/exec` an unexpanded glob
 * (`../worktrees/feature/<issue>-` followed by a star and a slash) and `/exec`
 * was instructed to trust it without checking. Two things went wrong:
 *
 * 1. When nothing had created the worktree, the `cd` failed and the agent
 *    silently kept working in the main checkout.
 * 2. `../worktrees/` is one flat namespace shared by every repo under the same
 *    parent directory, and issue numbers are per-repo — so where the glob *did*
 *    match, it could match a sibling project's worktree.
 *
 * Both are fixed the same way: never resolve worktrees through the filesystem.
 * `git worktree list` reports only the worktrees of the repository containing
 * `cwd`, so scoping is structural rather than a filter that can be forgotten,
 * and it reports the *branch*, which is the real identity — a worktree
 * directory slug can drift from its branch after a rename.
 */

import { existsSync, realpathSync, statSync } from "fs";
import path from "path";
import { listWorktrees } from "./worktree-manager.js";

/** Named failure modes for `resolveIssueWorktree`. */
export type ResolveErrorCode = "WORKTREE_NOT_FOUND" | "WORKTREE_AMBIGUOUS";

/** Named failure modes for `verifyWorktreePath`. */
export type VerifyErrorCode =
  | "SEQUANT_WORKTREE_NOT_FOUND"
  | "SEQUANT_WORKTREE_FOREIGN"
  | "SEQUANT_WORKTREE_ISSUE_MISMATCH";

/** A worktree of the current repository, as reported by git. */
export interface ResolvedWorktree {
  /** Absolute path, exactly as git reports it. */
  path: string;
  /** Branch checked out there, e.g. `feature/899-some-slug`. */
  branch: string;
}

export type ResolveResult =
  | ({ ok: true } & ResolvedWorktree)
  | {
      ok: false;
      error: ResolveErrorCode;
      message: string;
      /** Populated for WORKTREE_AMBIGUOUS so the caller can report candidates. */
      candidates: ResolvedWorktree[];
    };

export type VerifyResult =
  | ({ ok: true } & ResolvedWorktree)
  | { ok: false; error: VerifyErrorCode; message: string };

/**
 * Find the worktree of the *current* repository that holds issue `issue`.
 *
 * Selection keys on the branch git reports, never on the directory name, so a
 * worktree whose slug has drifted from its branch still resolves — and a
 * directory that merely looks like a match (a sibling repo's worktree, or a
 * stray directory) never does.
 *
 * @param issue - Issue number to look up.
 * @param cwd - Directory inside the repository to search. Defaults to process cwd.
 */
export function resolveIssueWorktree(
  issue: number,
  cwd?: string,
): ResolveResult {
  const matches = listWorktrees(cwd)
    .filter((w) => w.issue === issue)
    .map(({ path: p, branch }) => ({ path: p, branch }));

  if (matches.length === 0) {
    return {
      ok: false,
      error: "WORKTREE_NOT_FOUND",
      message:
        `WORKTREE_NOT_FOUND: no worktree of this repository has a branch for issue #${issue}. ` +
        `Create one with \`./scripts/new-feature.sh ${issue}\`.`,
      candidates: [],
    };
  }

  if (matches.length > 1) {
    const list = matches.map((m) => `${m.branch} -> ${m.path}`).join("; ");
    return {
      ok: false,
      error: "WORKTREE_AMBIGUOUS",
      message:
        `WORKTREE_AMBIGUOUS: ${matches.length} worktrees claim issue #${issue} (${list}). ` +
        `Remove the stale one, or set SEQUANT_WORKTREE explicitly.`,
      candidates: matches,
    };
  }

  return { ok: true, ...matches[0] };
}

/**
 * Canonicalize a path for comparison, tolerating paths that do not exist.
 *
 * `realpathSync` throws on a missing path, so fall back to resolving the
 * deepest existing ancestor and re-appending the remainder — enough to make
 * `/tmp/...` and `/private/tmp/...` compare equal on macOS.
 */
function canonicalize(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalize(parent), path.basename(absolute));
  }
}

/**
 * Verify that a caller-supplied worktree path is safe to work in.
 *
 * This is the guard `/exec` runs before trusting `SEQUANT_WORKTREE`. It fails
 * closed on every uncertain case — a bad path must halt the run, never degrade
 * into "keep going in whatever directory we happen to be in".
 *
 * @param worktreePath - The path to check (typically `$SEQUANT_WORKTREE`).
 * @param options.issue - When set, the branch must belong to this issue.
 * @param options.cwd - Directory inside the repository to check against.
 */
export function verifyWorktreePath(
  worktreePath: string,
  options: { issue?: number; cwd?: string } = {},
): VerifyResult {
  const raw = worktreePath.trim();

  if (raw.length === 0 || raw.includes("*")) {
    return {
      ok: false,
      error: "SEQUANT_WORKTREE_NOT_FOUND",
      message: `SEQUANT_WORKTREE_NOT_FOUND: ${raw.length === 0 ? "empty path" : `unexpanded glob "${raw}"`}. Expected a resolved absolute directory.`,
    };
  }

  const absolute = path.resolve(raw);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    return {
      ok: false,
      error: "SEQUANT_WORKTREE_NOT_FOUND",
      message: `SEQUANT_WORKTREE_NOT_FOUND: "${raw}" is not an existing directory.`,
    };
  }

  const canonical = canonicalize(absolute);
  const known = listWorktrees(options.cwd);
  const match = known.find((w) => canonicalize(w.path) === canonical);

  if (!match) {
    return {
      ok: false,
      error: "SEQUANT_WORKTREE_FOREIGN",
      message:
        `SEQUANT_WORKTREE_FOREIGN: "${raw}" is not a worktree of this repository. ` +
        `It belongs to another project or is stale; \`../worktrees/\` is shared across repos.`,
    };
  }

  if (options.issue !== undefined && match.issue !== options.issue) {
    return {
      ok: false,
      error: "SEQUANT_WORKTREE_ISSUE_MISMATCH",
      message:
        `SEQUANT_WORKTREE_ISSUE_MISMATCH: "${raw}" has branch "${match.branch}", ` +
        `which is not issue #${options.issue}.`,
    };
  }

  return { ok: true, path: match.path, branch: match.branch };
}
