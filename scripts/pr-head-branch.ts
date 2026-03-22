#!/usr/bin/env npx tsx
/**
 * Get the head branch name for a PR by number.
 *
 * Used by hooks/pre-tool.sh to consolidate gh CLI calls through GitHubProvider.
 * Usage: npx tsx scripts/pr-head-branch.ts <pr-number>
 * Outputs: branch name on stdout (empty on failure)
 */

import { GitHubProvider } from "../src/lib/workflow/platforms/github.js";

const prNumber = parseInt(process.argv[2], 10);
if (!prNumber) {
  process.exit(1);
}

const github = new GitHubProvider();
const branch = github.getPRHeadBranchSync(prNumber);
if (branch) {
  process.stdout.write(branch);
}
