/**
 * CLI wrapper for worktree-isolation module.
 *
 * Exposes the tested TypeScript API as shell commands so the exec SKILL.md
 * calls the same code that unit tests cover, preventing bash/TS drift.
 *
 * Usage:
 *   npx tsx scripts/worktree-isolation.ts create <worktree-path> <agent-index>
 *   npx tsx scripts/worktree-isolation.ts merge-all <worktree-path>
 *   npx tsx scripts/worktree-isolation.ts cleanup <worktree-path>
 *
 * All commands output JSON to stdout.
 */

import {
  createSubWorktree,
  mergeAllSubWorktrees,
  cleanupAllSubWorktrees,
  formatMergeResult,
  type SubWorktreeInfo,
} from "../src/lib/worktree-isolation.ts";
import { resolve } from "path";

const [command, ...args] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/worktree-isolation.ts create <worktree-path> <agent-index>
  npx tsx scripts/worktree-isolation.ts merge-all <worktree-path>
  npx tsx scripts/worktree-isolation.ts cleanup <worktree-path>`);
  process.exit(1);
}

if (!command) usage();

switch (command) {
  case "create": {
    const [worktreePath, indexStr] = args;
    if (!worktreePath || indexStr === undefined) usage();
    const agentIndex = parseInt(indexStr, 10);
    if (isNaN(agentIndex)) {
      console.error(`Invalid agent index: ${indexStr}`);
      process.exit(1);
    }
    const result = createSubWorktree(resolve(worktreePath), agentIndex);
    if (result) {
      console.log(JSON.stringify(result));
    } else {
      console.error("Failed to create sub-worktree");
      process.exit(1);
    }
    break;
  }

  case "merge-all": {
    const [worktreePath] = args;
    if (!worktreePath) usage();
    const absPath = resolve(worktreePath);

    // Discover sub-worktree branches by listing exec-agent-* branches
    const { execSync } = await import("child_process");
    let branches: string[];
    try {
      const output = execSync("git branch --list exec-agent-*", {
        cwd: absPath,
        encoding: "utf-8",
      }).trim();
      branches = output
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
    } catch {
      branches = [];
    }

    if (branches.length === 0) {
      console.log(JSON.stringify({ merged: 0, conflicts: 0, results: [] }));
      break;
    }

    // Build SubWorktreeInfo from discovered branches
    const subs: SubWorktreeInfo[] = branches.map((branch, i) => ({
      path: `${absPath}/.exec-agents/agent-${i}`,
      branch,
      agentIndex: i,
    }));

    const result = mergeAllSubWorktrees(absPath, subs);
    console.log(JSON.stringify(result));
    if (result.conflicts > 0) {
      console.error(formatMergeResult(result));
    }
    break;
  }

  case "cleanup": {
    const [worktreePath] = args;
    if (!worktreePath) usage();
    cleanupAllSubWorktrees(resolve(worktreePath));
    console.log(JSON.stringify({ cleaned: true }));
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    usage();
}
