/**
 * CLI shim for the qa-stagnation module (issue #581).
 *
 * Exposes the tested TypeScript API as shell commands so the fullsolve and
 * loop SKILL.md files invoke the same code that unit tests cover.
 *
 * Usage:
 *   npx tsx scripts/qa-stagnation.ts detect <issue-number>
 *   npx tsx scripts/qa-stagnation.ts record <issue-number> <iteration> <reason> [--verdict=...]
 *   npx tsx scripts/qa-stagnation.ts snapshot          # prints LoopProgressSnapshot JSON
 *   npx tsx scripts/qa-stagnation.ts compare-snapshot <before-json> <after-json>
 *
 * All commands output JSON to stdout. Exit code is always 0 on a clean
 * decision; non-zero only on usage errors or unrecoverable failures.
 */

import { execSync } from "child_process";
import {
  detectStagnation,
  recordStagnation,
  readHeadSha,
  readIsDirty,
  snapshotLoopProgress,
  compareLoopProgress,
  type LoopProgressSnapshot,
  type StagnationReason,
} from "../src/lib/workflow/qa-stagnation.ts";
import {
  PhaseMarkerSchema,
  type PhaseMarker,
} from "../src/lib/workflow/state-schema.ts";

const [command, ...args] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/qa-stagnation.ts detect <issue-number>
  npx tsx scripts/qa-stagnation.ts record <issue-number> <iteration> <reason> [--verdict=...]
  npx tsx scripts/qa-stagnation.ts snapshot
  npx tsx scripts/qa-stagnation.ts compare-snapshot <before-json> <after-json>`);
  process.exit(1);
}

if (!command) usage();

/**
 * Fetch the latest qa phase marker from a GitHub issue's comments.
 * Returns `null` if no qa marker exists.
 */
function fetchLatestQaMarker(issueNumber: number): PhaseMarker | null {
  const raw = execSync(
    `gh issue view ${issueNumber} --json comments --jq '.comments[].body'`,
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );
  const markerLines = raw
    .split("\n")
    .map((line) => {
      const m = line.match(
        /<!--\s*SEQUANT_PHASE:\s*(\{[^}]*"phase":"qa"[^}]*\})\s*-->/,
      );
      return m ? m[1] : null;
    })
    .filter((s): s is string => s !== null);

  if (markerLines.length === 0) return null;

  const last = markerLines[markerLines.length - 1];
  try {
    const parsed = JSON.parse(last);
    return PhaseMarkerSchema.parse(parsed);
  } catch {
    return null;
  }
}

switch (command) {
  case "detect": {
    const [issueArg] = args;
    if (!issueArg) usage();
    const issueNumber = parseInt(issueArg, 10);
    if (isNaN(issueNumber)) {
      console.error(`Invalid issue number: ${issueArg}`);
      process.exit(1);
    }

    const lastMarker = fetchLatestQaMarker(issueNumber);
    const decision = detectStagnation({
      currentSha: readHeadSha(),
      isDirty: readIsDirty(),
      lastMarker,
    });
    console.log(JSON.stringify(decision));
    break;
  }

  case "record": {
    const [issueArg, iterationArg, reasonArg] = args;
    if (!issueArg || !iterationArg || !reasonArg) usage();
    const issueNumber = parseInt(issueArg, 10);
    const iteration = parseInt(iterationArg, 10);
    if (isNaN(issueNumber) || isNaN(iteration)) {
      console.error("Invalid issue number or iteration");
      process.exit(1);
    }
    if (reasonArg !== "SAME_SHA_NO_PROGRESS" && reasonArg !== "LOOP_NO_DIFF") {
      console.error(
        `Invalid reason '${reasonArg}'. Expected SAME_SHA_NO_PROGRESS or LOOP_NO_DIFF.`,
      );
      process.exit(1);
    }
    const reason = reasonArg as StagnationReason;
    const verdictFlag = args.find((a) => a.startsWith("--verdict="));
    const verdict = verdictFlag ? verdictFlag.slice("--verdict=".length) : "";

    await recordStagnation(issueNumber, {
      sha: readHeadSha(),
      verdict,
      iteration,
      reason,
    });
    console.log(JSON.stringify({ recorded: true, issue: issueNumber, reason }));
    break;
  }

  case "snapshot": {
    const snapshot = snapshotLoopProgress();
    console.log(JSON.stringify(snapshot));
    break;
  }

  case "compare-snapshot": {
    const [beforeJson, afterJson] = args;
    if (!beforeJson || !afterJson) usage();
    let before: LoopProgressSnapshot;
    let after: LoopProgressSnapshot;
    try {
      before = JSON.parse(beforeJson);
      after = JSON.parse(afterJson);
    } catch (err) {
      console.error(`Invalid snapshot JSON: ${(err as Error).message}`);
      process.exit(1);
    }
    const decision = compareLoopProgress(before, after);
    console.log(JSON.stringify(decision));
    break;
  }

  default:
    usage();
}
