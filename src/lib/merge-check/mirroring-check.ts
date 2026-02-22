/**
 * Template/source mirroring check (AC-2)
 *
 * Detects paired directories and verifies that when a file is modified
 * in one location, the corresponding file in the mirror is also modified.
 */

import type {
  BranchInfo,
  CheckResult,
  BranchCheckResult,
  CheckFinding,
  MirrorPair,
  UnmirroredChange,
} from "./types.js";

/**
 * Check if a file path falls within any mirror pair
 */
function findMirrorPair(
  filePath: string,
  mirrorPairs: MirrorPair[],
): {
  pair: MirrorPair;
  side: "source" | "target";
  relativePath: string;
} | null {
  for (const pair of mirrorPairs) {
    if (filePath.startsWith(pair.source + "/")) {
      return {
        pair,
        side: "source",
        relativePath: filePath.slice(pair.source.length + 1),
      };
    }
    if (filePath.startsWith(pair.target + "/")) {
      return {
        pair,
        side: "target",
        relativePath: filePath.slice(pair.target.length + 1),
      };
    }
  }
  return null;
}

/**
 * Get the expected mirror path for a file
 */
function getMirrorPath(
  filePath: string,
  mirrorPairs: MirrorPair[],
): string | null {
  const match = findMirrorPair(filePath, mirrorPairs);
  if (!match) return null;

  if (match.side === "source") {
    return `${match.pair.target}/${match.relativePath}`;
  }
  return `${match.pair.source}/${match.relativePath}`;
}

/**
 * Run mirroring check across all branches
 *
 * For each file modified by a branch, if it falls within a mirrored directory,
 * verify that the corresponding mirror file was also modified.
 */
export function runMirroringCheck(
  branches: BranchInfo[],
  mirrorPairs: MirrorPair[],
): CheckResult {
  const startTime = Date.now();
  const branchResults: BranchCheckResult[] = [];
  const batchFindings: CheckFinding[] = [];

  for (const branch of branches) {
    const findings: CheckFinding[] = [];
    const unmirroredChanges: UnmirroredChange[] = [];

    for (const file of branch.filesModified) {
      const mirrorPath = getMirrorPath(file, mirrorPairs);
      if (!mirrorPath) continue;

      // Check if the mirror file was also modified in this branch
      const mirrorModified = branch.filesModified.includes(mirrorPath);
      if (!mirrorModified) {
        const match = findMirrorPair(file, mirrorPairs);
        if (match) {
          unmirroredChanges.push({
            sourceFile: file,
            targetFile: mirrorPath,
            direction: match.side === "source" ? "source-only" : "target-only",
            issueNumber: branch.issueNumber,
          });
        }
      }
    }

    if (unmirroredChanges.length > 0) {
      for (const change of unmirroredChanges) {
        findings.push({
          check: "mirroring",
          severity: "warning",
          message: `Modified ${change.sourceFile} but not its mirror ${change.targetFile}`,
          file: change.sourceFile,
          issueNumber: branch.issueNumber,
        });
      }
    }

    branchResults.push({
      issueNumber: branch.issueNumber,
      verdict: unmirroredChanges.length > 0 ? "WARN" : "PASS",
      findings,
    });
  }

  const hasWarnings = branchResults.some((r) => r.verdict !== "PASS");
  return {
    name: "mirroring",
    passed: !hasWarnings,
    branchResults,
    batchFindings,
    durationMs: Date.now() - startTime,
  };
}
