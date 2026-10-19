/**
 * `sequant worktree` — repo-scoped worktree resolution for skill bodies (#899).
 *
 * `/fullsolve` uses `resolve` to turn an issue number into a real absolute
 * path before exporting `SEQUANT_WORKTREE`; `/exec` uses `verify` to refuse a
 * path that does not exist or belongs to another repository. Both fail closed:
 * a non-zero exit means the caller must halt, not continue where it stands.
 */

import chalk from "chalk";
import {
  resolveIssueWorktree,
  verifyWorktreePath,
} from "../lib/workflow/worktree-resolver.js";

export interface WorktreeResolveOptions {
  json?: boolean;
}

export interface WorktreeVerifyOptions {
  issue?: string;
  json?: boolean;
}

function parseIssue(arg: string): number | null {
  const issue = Number.parseInt(arg, 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error(chalk.red(`Invalid issue number: ${arg}`));
    process.exitCode = 2;
    return null;
  }
  return issue;
}

/**
 * `sequant worktree resolve <issue>` — print the absolute path of this
 * repository's worktree for an issue.
 *
 * On success the path is the *only* thing written to stdout, so callers can
 * capture it with `WT="$(sequant worktree resolve 123)"`. Everything else goes
 * to stderr.
 */
export async function worktreeResolveCommand(
  issueArg: string,
  options: WorktreeResolveOptions = {},
): Promise<void> {
  const issue = parseIssue(issueArg);
  if (issue === null) return;

  const result = resolveIssueWorktree(issue);

  if (!result.ok) {
    process.exitCode = 1;
    if (options.json) {
      console.error(
        JSON.stringify({
          issue,
          ok: false,
          error: result.error,
          message: result.message,
          candidates: result.candidates,
        }),
      );
    } else {
      console.error(chalk.red(result.message));
    }
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify({
        issue,
        ok: true,
        path: result.path,
        branch: result.branch,
      }),
    );
    return;
  }

  // Bare path only — this is consumed by `$(...)` in skill bodies.
  console.log(result.path);
}

/**
 * `sequant worktree verify <path>` — confirm a path is a worktree of this
 * repository (and, with `--issue`, that it belongs to that issue).
 *
 * Exit 1 with a named error is the signal for `/exec` to halt.
 */
export async function worktreeVerifyCommand(
  pathArg: string,
  options: WorktreeVerifyOptions = {},
): Promise<void> {
  let issue: number | undefined;
  if (options.issue !== undefined) {
    const parsed = parseIssue(options.issue);
    if (parsed === null) return;
    issue = parsed;
  }

  const result = verifyWorktreePath(pathArg, { issue });

  if (!result.ok) {
    process.exitCode = 1;
    if (options.json) {
      console.error(
        JSON.stringify({
          ok: false,
          error: result.error,
          message: result.message,
        }),
      );
    } else {
      console.error(chalk.red(result.message));
    }
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify({ ok: true, path: result.path, branch: result.branch }),
    );
    return;
  }

  console.log(chalk.green(`✓ ${result.path} (${result.branch})`));
}
