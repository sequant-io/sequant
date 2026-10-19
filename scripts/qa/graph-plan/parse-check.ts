#!/usr/bin/env npx tsx
/**
 * Graph-plan checker: parse every issue body in a directory with the repo's
 * own AC parser and report what the runner and `/qa` will see.
 *
 * Usage: npx tsx scripts/qa/graph-plan/parse-check.ts <issues-dir>
 *
 * For each `*.md` file prints one line:
 *   <file>: acs=N evidence=N gate=N nonGoals=true|false blockedByItems=N
 * and, for any AC without an `Evidence:` clause, a `NO EVIDENCE:` line.
 *
 * - `acs` / `evidence` come from `parseAcceptanceCriteria` (#938): an AC whose
 *   Evidence is missing is invisible to `/qa` §6h/§6i.
 * - `gate` counts ACs `isGateTestEvidence` classifies as gate tests; each of
 *   those needs a `SEQUANT_MUTATION` record in the PR body (CLAUDE.md).
 * - `nonGoals` is the `## Non-Goals` heading the scope assessment reads.
 * - `blockedByItems` counts `- **Blocked by**: #N` list items, the only form
 *   `parseBodyDependencyMarkers` sees (the metadata line is for humans).
 *
 * Exit code 1 when any AC lacks Evidence, so it can gate a filing script.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isGateTestEvidence,
  parseAcceptanceCriteria,
} from "../../../src/lib/ac-parser.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: parse-check.ts <issues-dir>");
  process.exit(2);
}

let missing = 0;
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".md"))
  .sort()) {
  const body = readFileSync(join(dir, file), "utf8");
  const acs = parseAcceptanceCriteria(body);
  const withEvidence = acs.filter((a) => a.evidence);
  const gates = withEvidence.filter((a) => isGateTestEvidence(a.evidence ?? ""));
  const nonGoals = /^## Non-Goals/m.test(body);
  const blockedBy = (body.match(/^- \*\*Blocked by\*\*: /gm) ?? []).length;
  console.log(
    `${file}: acs=${acs.length} evidence=${withEvidence.length} gate=${gates.length} nonGoals=${nonGoals} blockedByItems=${blockedBy}`,
  );
  for (const a of acs) {
    if (!a.evidence) {
      missing++;
      console.log(`   NO EVIDENCE: ${a.id} ${a.description.slice(0, 60)}`);
    }
  }
  for (const g of gates) console.log(`   gate: ${g.id}`);
}
process.exit(missing > 0 ? 1 : 0);
