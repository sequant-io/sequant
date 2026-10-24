#!/usr/bin/env npx tsx
/**
 * AC attribution rate (#1520 AC-1).
 *
 * The Read-first comment (`src/lib/workflow/review-residue.ts`) counts a file
 * as explained only when an AC's `Evidence:` clause names its path (R-2).
 * This script measures how many ACs can explain anything at all: over the
 * issues closed since a date, the share of ACs whose evidence names at least
 * one path, bare or as a command argument. It uses the same
 * `evidenceTargets` parse the comment uses, so the rate is the shipped rule's.
 *
 * The number is reported, not gated: an AC that names nothing leaves its
 * files in residue, which is the conservative default.
 *
 * Usage:
 *   npx tsx scripts/qa/ac-attribution-rate.ts --closed-since 2026-09-20 [--json]
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { parseAcceptanceCriteria } from "../../src/lib/ac-parser.js";
import { GitHubProvider } from "../../src/lib/workflow/platforms/github.js";
import { evidenceTargets } from "../../src/lib/workflow/review-residue.js";

export interface AttributionReport {
  closedSince: string;
  issues: number;
  acs: number;
  /** ACs with an `Evidence:` clause. */
  withEvidence: number;
  /** ACs whose evidence names at least one path. */
  attributed: number;
  /** `attributed / acs`, 0 when there are no ACs. */
  rate: number;
}

export function measureAttribution(
  issues: { body: string }[],
  closedSince: string,
): AttributionReport {
  let acs = 0;
  let withEvidence = 0;
  let attributed = 0;
  for (const issue of issues) {
    for (const ac of parseAcceptanceCriteria(issue.body ?? "")) {
      acs++;
      if (ac.evidence) withEvidence++;
      if (evidenceTargets(ac.evidence).length > 0) attributed++;
    }
  }
  return {
    closedSince,
    issues: issues.length,
    acs,
    withEvidence,
    attributed,
    rate: acs === 0 ? 0 : Math.round((attributed / acs) * 1000) / 1000,
  };
}

export function main(
  argv: string[],
  provider: GitHubProvider = new GitHubProvider(),
): number {
  const i = argv.indexOf("--closed-since");
  const since = i >= 0 ? argv[i + 1] : undefined;
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error(
      "Usage: ac-attribution-rate.ts --closed-since YYYY-MM-DD [--json]",
    );
    return 2;
  }
  const report = measureAttribution(
    provider.listClosedIssuesWithBodySync(since),
    since,
  );
  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${report.attributed} of ${report.acs} ACs (${(report.rate * 100).toFixed(1)}%) ` +
        `across ${report.issues} issues closed since ${since} name a path in their evidence ` +
        `(\`npx tsx scripts/qa/ac-attribution-rate.ts --closed-since ${since} --json\`)`,
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
