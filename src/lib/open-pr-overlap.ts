/**
 * Open-PR overlap: which open PRs on origin change files the current work
 * also changes (#1454).
 *
 * The single intersection both consumers share. `merge-check` passes the
 * batch's files under one key; `assess-collision-detect` passes one key per
 * issue. Each consumer formats the result its own way. The PR file lists come
 * from `GitHubProvider.listOpenPRFilesSync`.
 */

import type { OpenPRFiles } from "./workflow/platforms/github.js";

/** One open PR that shares paths with one unit of work. */
export interface OpenPrOverlap<K> {
  /** The work unit the PR overlaps (an issue number, or a batch key). */
  key: K;
  prNumber: number;
  headRefName: string;
  /** Shared paths, sorted ascending. */
  sharedPaths: string[];
}

/**
 * Intersect each work unit's paths with each open PR's changed files.
 *
 * PRs whose head branch is in `excludeHeads` are the work itself (the batch's
 * own PRs) and are skipped. Results are ordered by work-unit insertion order,
 * then ascending PR number.
 */
export function findOpenPrOverlaps<K>(
  workPaths: Map<K, Iterable<string>>,
  prs: OpenPRFiles[],
  excludeHeads: ReadonlySet<string> = new Set(),
): OpenPrOverlap<K>[] {
  const sortedPrs = [...prs]
    .filter((pr) => !excludeHeads.has(pr.headRefName))
    .sort((a, b) => a.number - b.number);
  const results: OpenPrOverlap<K>[] = [];

  for (const [key, paths] of workPaths) {
    const own = new Set(paths);
    for (const pr of sortedPrs) {
      const shared = [...new Set(pr.files)].filter((f) => own.has(f)).sort();
      if (shared.length === 0) continue;
      results.push({
        key,
        prNumber: pr.number,
        headRefName: pr.headRefName,
        sharedPaths: shared,
      });
    }
  }

  return results;
}
