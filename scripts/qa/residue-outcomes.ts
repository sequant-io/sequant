#!/usr/bin/env npx tsx
/**
 * Read-first outcomes (#1520 AC-6).
 *
 * Over the PRs merged since a date, splits those carrying a Read-first
 * comment into two groups, non-empty residue and empty residue, and counts
 * in each how many drew a reviewer comment after the Read-first comment and
 * before the merge.
 *
 * Lagging and confounded, by design of the question: the number cannot tell
 * a residue that was read and found fine from one nobody opened. The null
 * result is named up front: if residue does not change what reviewers do,
 * the two groups look the same here.
 *
 * A "reviewer comment" is any comment that is not itself a Read-first
 * comment, carries no `SEQUANT_` machine marker, and is not from a bot
 * account. The orchestrator posts as the user's own account, so the marker
 * is what separates its comments from the user's.
 *
 * Usage:
 *   npx tsx scripts/qa/residue-outcomes.ts --since 2026-10-24 [--json]
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  GitHubProvider,
  type MergedPRWithComments,
} from "../../src/lib/workflow/platforms/github.js";
import { isReadFirstComment } from "../../src/lib/workflow/review-residue.js";

interface Group {
  total: number;
  commentedBeforeMerge: number;
}

export interface ResidueOutcomes {
  since: string;
  prsMerged: number;
  withResidue: Group;
  emptyResidue: Group;
}

/** Whether the comment's `## Residue` section is the single "none" line. */
export function residueIsEmpty(body: string): boolean {
  const match = body.match(/\n## Residue\n([\s\S]*?)(\n## |$)/);
  if (!match) return false;
  const lines = match[1].split("\n").filter((l) => l.startsWith("- "));
  return lines.length === 1 && lines[0].startsWith("- none —");
}

function isReviewerComment(
  c: MergedPRWithComments["comments"][number],
): boolean {
  const login = c.author?.login ?? "";
  return (
    !isReadFirstComment(c.body) &&
    !c.body.includes("<!-- SEQUANT_") &&
    !login.endsWith("[bot]") &&
    login !== "github-actions"
  );
}

export function measureOutcomes(
  prs: MergedPRWithComments[],
  since: string,
): ResidueOutcomes {
  const withResidue: Group = { total: 0, commentedBeforeMerge: 0 };
  const emptyResidue: Group = { total: 0, commentedBeforeMerge: 0 };
  for (const pr of prs) {
    const readFirst = pr.comments.find((c) => isReadFirstComment(c.body));
    if (!readFirst) continue;
    const group = residueIsEmpty(readFirst.body) ? emptyResidue : withResidue;
    group.total++;
    const commented = pr.comments.some(
      (c) =>
        isReviewerComment(c) &&
        c.createdAt > readFirst.createdAt &&
        c.createdAt < pr.mergedAt,
    );
    if (commented) group.commentedBeforeMerge++;
  }
  return { since, prsMerged: prs.length, withResidue, emptyResidue };
}

export function main(
  argv: string[],
  provider: GitHubProvider = new GitHubProvider(),
): number {
  const i = argv.indexOf("--since");
  const since = i >= 0 ? argv[i + 1] : undefined;
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error("Usage: residue-outcomes.ts --since YYYY-MM-DD [--json]");
    return 2;
  }
  const report = measureOutcomes(
    provider.listMergedPRsWithCommentsSync(since),
    since,
  );
  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const line = (name: string, g: Group): string =>
      `${name}: ${g.commentedBeforeMerge} of ${g.total} PRs drew a reviewer comment before merge`;
    console.log(
      [
        `${report.prsMerged} PRs merged since ${since}`,
        line("non-empty residue", report.withResidue),
        line("empty residue", report.emptyResidue),
      ].join("\n"),
    );
  }
  return 0;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2));
}
