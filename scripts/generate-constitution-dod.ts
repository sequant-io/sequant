#!/usr/bin/env npx tsx
/**
 * Generate the Definition of Done table for the constitution template.
 *
 * Reads §7's step-4 verdict branches from `.claude/skills/qa/SKILL.md`
 * (the canonical source per `lint-skill-gates.ts`'s SCAN_ROOTS precedence)
 * and renders them as a markdown table. Output is the table content that lives
 * between the <!-- BEGIN:DOD-GATES --> / <!-- END:DOD-GATES --> markers in
 * `templates/memory/constitution.md`.
 *
 * The accompanying drift check (`check-constitution-dod.ts`) compares the
 * generated table against the committed template and fails CI on divergence.
 *
 * Usage:
 *   npx tsx scripts/generate-constitution-dod.ts          # print table to stdout
 *
 * Related: #943, lint-skill-gates.ts (reuses ALGORITHM_MARKER region logic)
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_ROOT = join(__dirname, "..");

/**
 * Canonical qa skill path.
 * Same first-match precedence as lint-skill-gates.ts SCAN_ROOTS:
 * `.claude/skills` → `templates/skills` → `skills`.
 */
export function resolveQaSkillPath(root: string): string {
  const candidates = [
    join(root, ".claude", "skills", "qa", "SKILL.md"),
    join(root, "templates", "skills", "qa", "SKILL.md"),
    join(root, "skills", "qa", "SKILL.md"),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      // try next
    }
  }
  return candidates[0]; // let the caller surface the missing-file error
}

const ALGORITHM_MARKER = "Verdict Determination Algorithm (REQUIRED):";
const STEP4_MARKER = "4. Determine verdict";

/**
 * Human-readable gate names, keyed by the primary token in the condition.
 *
 * When a step-4 condition contains the key, the name is used. New gates added
 * to §7 step-4 that lack an entry here get their raw condition as the name and
 * are still emitted to the table — the drift check fails, prompting the author
 * to add a name entry here.
 */
const GATE_LABELS: Record<string, string> = {
  not_met_count: "All ACs MET",
  detection_pattern_status: "Detection patterns (§6c)",
  behavior_rule_survival_status: "Behavior-rule check (§6e)",
  trust_boundary_status: "Trust boundary (§6f)",
  cli_registration_status: "CLI registration (§2h)",
  mutation_verification_status: "Mutation verification (§6i)",
  adversarial_reread_status: "Adversarial re-read (§6d)",
  skill_verification: "Skill verification (§6a)",
  execution_evidence: "Script execution evidence",
  declared_evidence_status: "Declared evidence (§6h)",
  script_verification_status: "Script verification (§11)",
  changelog_required: "CHANGELOG entry (§10a)",
  quality_plan_status: "Quality plan (Phase 0b)",
  browser_test_missing: "Browser test",
  pending_count: "Pending verifications",
  smoke_test_status: "Smoke tests (§6b)",
  improvement_suggestions: "Improvement suggestions",
};

export interface Branch {
  condition: string;
  verdict: string;
}

/**
 * Extract step-4 verdict branches from the algorithm text block.
 *
 * Scoped to the delimited §7 block — the algorithm lives in the first
 * ```text fence after ALGORITHM_MARKER, inside step "4. Determine verdict".
 * Whole-file parsing lets unrelated text satisfy the extraction (the #830
 * gate-test scoping trap), so we bound to step-4 only.
 */
export function parseStep4Branches(algorithmText: string): Branch[] {
  const lines = algorithmText.split("\n");
  let inStep4 = false;
  const branches: Branch[] = [];
  let pendingCondition: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Step 4 start
    if (trimmed.startsWith(STEP4_MARKER)) {
      inStep4 = true;
      continue;
    }

    // Next numbered step — stop (defensive against any step-5+ additions)
    if (inStep4 && /^\d+[a-z]?\.\s/.test(trimmed)) {
      break;
    }

    if (!inStep4) continue;

    // IF / ELSE IF condition line: "   - [ELSE ]IF <condition>:"
    const condMatch = /^-\s+(?:ELSE\s+)?IF\s+(.+?):\s*$/.exec(trimmed);
    if (condMatch) {
      pendingCondition = condMatch[1].trim();
      continue;
    }

    // Terminal ELSE (READY_FOR_MERGE — not a gate)
    if (/^-\s+ELSE:\s*$/.test(trimmed)) {
      pendingCondition = "ELSE";
      continue;
    }

    // Verdict line: "       → VERDICT_TOKEN ..."
    const verdictMatch = /^→\s+(\w+)/.exec(trimmed);
    if (verdictMatch && pendingCondition !== null) {
      branches.push({ condition: pendingCondition, verdict: verdictMatch[1] });
      pendingCondition = null;
    }
  }

  return branches;
}

/** Find the human-readable label for a condition. */
function gateLabel(condition: string): string {
  for (const [key, label] of Object.entries(GATE_LABELS)) {
    if (condition.includes(key)) return label;
  }
  return condition; // new gate — emit raw for visibility
}

/** Extract the trigger description from a condition string. */
function triggerLabel(condition: string): string {
  // Specific multi-token OR comparisons
  if (condition.includes(" OR ") && condition.includes("_count"))
    return "any `NOT_MET` or `PARTIALLY_MET`";
  // Single count threshold (e.g. "pending_count > 0")
  if (condition.includes("_count")) return "count `> 0`";
  // .length comparisons (e.g. "improvement_suggestions.length > 0")
  if (condition.includes(".length")) return "list non-empty";
  // Compound boolean (e.g. "changelog_required AND changelog_missing")
  if (condition.includes(" AND ")) return "both conditions true";
  // Bare flag ("browser_test_missing (from step 3)")
  if (
    !condition.includes("==") &&
    !condition.includes(">") &&
    !condition.includes("<")
  ) {
    return "condition true";
  }
  // Status equality: token == "Status"
  const quoted = /==\s*"([^"]+)"/.exec(condition);
  if (quoted) return `\`${quoted[1]}\``;
  return condition;
}

/** Map a verdict token to its human-readable impact description. */
function verdictLabel(verdict: string): string {
  switch (verdict) {
    case "AC_NOT_MET":
      return "`AC_NOT_MET` — blocks merge";
    case "AC_MET_BUT_NOT_A_PLUS":
      return "`AC_MET_BUT_NOT_A_PLUS` — cannot be A+";
    case "NEEDS_VERIFICATION":
      return "`NEEDS_VERIFICATION` — holds for external verification";
    case "READY_FOR_MERGE":
      return "`READY_FOR_MERGE` — A+";
    default:
      return `\`${verdict}\``;
  }
}

/**
 * Generate the DoD gate table from the qa skill content.
 *
 * Returns the markdown table string (header + rows), suitable for embedding
 * between the BEGIN:DOD-GATES / END:DOD-GATES delimiters.
 *
 * Throws if the algorithm block cannot be found or is empty.
 */
export function generateDodTable(qaSkillContent: string): string {
  // Scope to the delimited §7 algorithm block
  const markerIdx = qaSkillContent.indexOf(ALGORITHM_MARKER);
  if (markerIdx === -1) {
    throw new Error(
      `Algorithm marker not found in qa skill: "${ALGORITHM_MARKER}"`,
    );
  }

  const afterMarker = qaSkillContent.slice(markerIdx);

  // First ``` fence after the marker
  const fenceOpen = afterMarker.indexOf("```");
  if (fenceOpen === -1)
    throw new Error("No fenced block found after algorithm marker");

  const newlineAfterOpen = afterMarker.indexOf("\n", fenceOpen);
  if (newlineAfterOpen === -1) throw new Error("Malformed fence opening");

  const fenceClose = afterMarker.indexOf("```", fenceOpen + 3);
  if (fenceClose === -1) throw new Error("Unclosed fenced block in algorithm");

  const algorithmText = afterMarker.slice(newlineAfterOpen + 1, fenceClose);

  const branches = parseStep4Branches(algorithmText);
  if (branches.length === 0) {
    throw new Error(
      "No step-4 branches found in algorithm block — parser may need updating",
    );
  }

  const rows = branches
    // ELSE / READY_FOR_MERGE is success, not a gate
    .filter((b) => b.verdict !== "READY_FOR_MERGE" && b.condition !== "ELSE")
    .map((b) => {
      const name = gateLabel(b.condition);
      const trigger = triggerLabel(b.condition);
      const impact = verdictLabel(b.verdict);
      return `| ${name} | ${trigger} | ${impact} |`;
    });

  return [
    "| Gate | Trigger | Verdict impact |",
    "|------|---------|----------------|",
    ...rows,
  ].join("\n");
}

// CLI entry — only when run directly, not when imported by tests or check script.
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const qaPath = resolveQaSkillPath(PROJECT_ROOT);
  let content: string;
  try {
    content = readFileSync(qaPath, "utf-8");
  } catch {
    console.error(`❌ qa skill not found: ${qaPath}`);
    process.exit(1);
  }

  try {
    console.log(generateDodTable(content));
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }
}
