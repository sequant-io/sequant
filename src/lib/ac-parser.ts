/**
 * Acceptance Criteria Parser
 *
 * Extracts acceptance criteria from GitHub issue markdown.
 * Supports checkbox format: `- [ ] **AC-1:** Description`
 * Also supports alternate formats: `- [ ] **B2:** Description`
 * And bold-wrapped format: `- [ ] **AC-1: Description**`
 *
 * Bare checkbox items (`- [ ] Some requirement`, no ID prefix) are also
 * honored, but ONLY under an explicit `## Acceptance Criteria` heading, where
 * they receive synthesized stable IDs. Human-authored issues rarely prefix
 * their ACs with IDs, so without this every hand-written issue parsed to zero
 * ACs — blinding every downstream AC consumer (#850).
 *
 * @example
 * ```typescript
 * import { parseAcceptanceCriteria } from './ac-parser';
 *
 * const issueBody = `
 * ## Acceptance Criteria
 * - [ ] **AC-1:** User can login
 * - [ ] **AC-2:** Session persists
 * `;
 *
 * const criteria = parseAcceptanceCriteria(issueBody);
 * // Returns: [
 * //   { id: 'AC-1', description: 'User can login', verificationMethod: 'manual', status: 'pending' },
 * //   { id: 'AC-2', description: 'Session persists', verificationMethod: 'manual', status: 'pending' }
 * // ]
 * ```
 */

import {
  type AcceptanceCriterion,
  type AcceptanceCriteria,
  type ACVerificationMethod,
  createAcceptanceCriterion,
  createAcceptanceCriteria,
} from "./workflow/state-schema.js";

/**
 * Regex patterns for AC extraction
 *
 * Matches:
 * - `- [ ] **AC-1:** Description`
 * - `- [x] **AC-1:** Description`
 * - `- [ ] **B2:** Description`
 * - `- [ ] **AC1:** Description`
 * - `- [ ] **AC-1: Description**` (bold wraps ID + description)
 * - `- [ ] **AC-1** Description` (bold ID, no colon)
 * - `- [ ] **AC-1**: Description` (colon outside the bold)
 * - `- [ ] AC-1: Description`
 */
const AC_PATTERNS = [
  // Pattern 1: `- [ ] **AC-1:** Description` or `- [x] **AC-1:** Description`
  /^-\s*\[[x\s]\]\s*\*\*([A-Za-z]+-?\d+):\*\*\s*(.+)$/gim,
  // Pattern 2: `- [ ] **B2:** Description` (letter + number without hyphen)
  /^-\s*\[[x\s]\]\s*\*\*([A-Za-z]\d+):\*\*\s*(.+)$/gim,
  // Pattern 3: `- [ ] **AC-1: Description.** optional text` (bold wraps ID + description)
  /^-\s*\[[x\s]\]\s*\*\*([A-Za-z]+-?\d+):\s*(.+?)\*\*\s*(.*)$/gim,
  // Pattern 4: `- [ ] AC-1: Description` (no bold)
  /^-\s*\[[x\s]\]\s*([A-Za-z]+-?\d+):\s*(.+)$/gim,
  // Pattern 5: `- [ ] **AC-1** Description` / `- [ ] **AC-1**: Description` (#808)
  //
  // The colon-less form is a very common authoring style, and before this
  // pattern existed it matched nothing at all — an issue written this way
  // parsed as ZERO acceptance criteria, silently, with no warning anywhere
  // downstream (#803's five ACs were written exactly like this).
  //
  // The trailing `:?` also absorbs a colon placed *outside* the bold, which
  // would otherwise land in the description as a leading ": ".
  //
  // Deliberately requires the bold markers. A bare `- [ ] AC1 something` is
  // ambiguous against ordinary checklist prose, so widening that far would
  // trade a silent miss for silent false positives. The `\d+` at the end of
  // the ID keeps non-identifier bold labels (`**Note**`, `**Verify**`) out.
  /^-\s*\[[x\s]\]\s*\*\*([A-Za-z]+-?\d+)\*\*:?\s*(.+)$/gim,
];

/**
 * Matches an `## Acceptance Criteria` heading (any level, case-insensitive).
 *
 * Real issues vary the casing — #703 uses `## Acceptance criteria` (lowercase
 * "criteria") — so the match must be case-insensitive. The trailing `\b` lets
 * a suffix follow ("Acceptance Criteria (v2)") without demanding an exact end.
 */
const AC_HEADING_RE = /^#{1,6}\s+acceptance\s+criteria\b/i;

/**
 * Matches any markdown ATX heading. Used to detect when the AC section ends —
 * the next heading of any level closes it, mirroring `parseNonGoals` in
 * `ready-gate.ts`.
 */
const HEADING_RE = /^#{1,6}\s+/;

/**
 * Matches a bare checkbox item with no ID prefix: `- [ ] Some requirement`.
 * Honored only inside the AC section (see {@link parseAcceptanceCriteria}).
 */
const BARE_CHECKBOX_RE = /^-\s*\[[x\s]\]\s*(.+)$/i;

/**
 * Keywords that suggest verification method
 */
const VERIFICATION_KEYWORDS: Record<string, ACVerificationMethod> = {
  // Unit test keywords
  unit: "unit_test",
  "unit test": "unit_test",
  unittest: "unit_test",

  // Integration test keywords
  integration: "integration_test",
  "integration test": "integration_test",
  api: "integration_test",
  endpoint: "integration_test",

  // Browser test keywords
  browser: "browser_test",
  "browser test": "browser_test",
  e2e: "browser_test",
  "end-to-end": "browser_test",
  ui: "browser_test",
  click: "browser_test",
  navigate: "browser_test",
  display: "browser_test",
  dashboard: "browser_test",

  // Manual keywords (explicit)
  manual: "manual",
  "manual test": "manual",
  verify: "manual",
};

/**
 * Infer verification method from description text
 *
 * @param description - The AC description text
 * @returns The inferred verification method (defaults to 'manual')
 */
export function inferVerificationMethod(
  description: string,
): ACVerificationMethod {
  const lowerDesc = description.toLowerCase();

  // Check for explicit keywords (longer phrases first)
  const sortedKeywords = Object.keys(VERIFICATION_KEYWORDS).sort(
    (a, b) => b.length - a.length,
  );

  for (const keyword of sortedKeywords) {
    if (lowerDesc.includes(keyword)) {
      return VERIFICATION_KEYWORDS[keyword];
    }
  }

  return "manual";
}

/**
 * Matches a trailing `Evidence:` clause on an AC line (#938). Only the
 * LAST occurrence is honored — the clause is defined as trailing, and AC
 * prose can legitimately contain the word "Evidence:" earlier in the
 * sentence (e.g. "the report cites strong Evidence: peer review ..."
 * before the real declaration). Splitting on the first match would corrupt
 * extraction by swallowing the real trailing clause into the description.
 */
const EVIDENCE_CLAUSE_RE = /\bEvidence:\s*/gi;

/**
 * Split a trailing `Evidence:` clause out of an AC description (#938).
 *
 * @param description - The AC description text (post ID-stripping)
 * @returns The description with the clause removed, plus the declared
 *   evidence text if present
 */
function splitEvidenceClause(description: string): {
  description: string;
  evidence?: string;
} {
  const matches = [...description.matchAll(EVIDENCE_CLAUSE_RE)];
  if (matches.length === 0) return { description };

  const last = matches[matches.length - 1];
  const before = description.slice(0, last.index).trim();
  const evidence = description.slice(last.index + last[0].length).trim();
  if (!before || !evidence) return { description };

  return { description: before, evidence };
}

/**
 * Matches a backtick-quoted command inside a declared evidence clause.
 * A command (vs. prose like "human review") is what makes evidence
 * runnable/checkable rather than a manual attestation.
 */
const EVIDENCE_COMMAND_RE = /`([^`]+)`/;

/**
 * Command tokens that indicate a unit-test invocation. Anything else
 * backtick-quoted (CLI commands, curl, scripts) is treated as an
 * integration-level check.
 */
const UNIT_TEST_COMMAND_RE = /\b(test|vitest|jest)\b/i;

/**
 * Resolve the verification method for an AC, preferring a declared
 * `Evidence:` clause over keyword inference (#938).
 *
 * - Evidence names a backtick-quoted command containing a unit-test
 *   token (`test`, `vitest`, `jest`) → `unit_test`.
 * - Evidence names any other backtick-quoted command → `integration_test`.
 * - Evidence is prose with no backtick command (e.g. "human review") →
 *   `manual`.
 * - No evidence declared → falls back to {@link inferVerificationMethod}.
 *
 * @param description - The AC description text (evidence clause stripped)
 * @param evidence - The declared evidence clause, if any
 * @returns The resolved verification method
 */
export function resolveVerificationMethod(
  description: string,
  evidence?: string,
): ACVerificationMethod {
  if (evidence) {
    const commandMatch = EVIDENCE_COMMAND_RE.exec(evidence);
    if (commandMatch) {
      return UNIT_TEST_COMMAND_RE.test(commandMatch[1])
        ? "unit_test"
        : "integration_test";
    }
    return "manual";
  }
  return inferVerificationMethod(description);
}

/**
 * Keywords matching the CLAUDE.md "gate test" definition — a test whose job
 * is to gate a claim that "a fixture exists, a skill section is present, a
 * flag is wired" (#830, #939). Distinct from {@link VERIFICATION_KEYWORDS}:
 * those classify *how* an AC is checked (unit/integration/browser/manual),
 * this classifies *what kind of claim* the test makes, independent of
 * verification method.
 *
 * A heuristic, not a hard classifier — same caveat {@link inferVerificationMethod}
 * already carries. Over-firing sweeps ordinary tests into the gate-test
 * population (inflating the mutation-verification gate's authoring burden);
 * under-firing lets a real gate test slip through ungated, the exact defect
 * class #830 exists to prevent.
 */
const GATE_TEST_KEYWORDS = [
  "fixture",
  "section",
  "flag",
  "wired",
  "exists",
  "present",
  "registered",
  "skill gate",
  // The mutation-verification rule (CLAUDE.md, #830) IS the gate-test
  // definition — an AC that already names its own mutation-verified record
  // is self-identifying, even when it doesn't separately name a
  // fixture/section/flag (e.g. "lint test fails when the §7 entry is
  // deleted (mutation-verified)").
  "mutation-verified",
  "mutation test",
];

/**
 * Whether a declared `Evidence:` clause describes a CLAUDE.md-style gate
 * test — a fixture-exists / section-present / flag-wired assertion — rather
 * than an ordinary behavioral unit/integration test.
 *
 * @param evidence - The declared evidence clause text (from {@link splitEvidenceClause})
 * @returns True when the evidence text matches the gate-test keyword set
 */
export function isGateTestEvidence(evidence: string): boolean {
  const lower = evidence.toLowerCase();
  return GATE_TEST_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/**
 * Parse a single line and extract AC if present
 *
 * @param line - A single line from the issue body
 * @returns Parsed AC or null if line doesn't match
 */
function parseACLine(
  line: string,
): { id: string; description: string; evidence?: string } | null {
  for (const pattern of AC_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    if (match) {
      // Combine groups 2 and 3 for bold-wrapped format (Pattern 3)
      // where group 3 captures optional text after closing **
      const rawDescription = match[3]
        ? `${match[2].trim()} ${match[3].trim()}`.trim()
        : match[2].trim();
      const { description, evidence } = splitEvidenceClause(rawDescription);
      return {
        id: match[1].toUpperCase(),
        description,
        ...(evidence !== undefined ? { evidence } : {}),
      };
    }
  }
  return null;
}

/**
 * Parse acceptance criteria from GitHub issue markdown
 *
 * Extracts AC items from checkbox format in the issue body.
 * Supports multiple formats:
 * - `- [ ] **AC-1:** Description`
 * - `- [ ] **B2:** Description`
 * - `- [ ] **AC-1: Description**` (bold wraps ID + description)
 * - `- [ ] **AC-1** Description` (bold ID, no colon)
 * - `- [ ] **AC-1**: Description` (colon outside the bold)
 * - `- [ ] AC-1: Description`
 *
 * Bare checkbox items without an ID prefix (`- [ ] Some requirement`) are also
 * parsed, but ONLY under an explicit `## Acceptance Criteria` heading, where
 * they receive synthesized stable IDs (`AC-1`, `AC-2`, ...). This keeps
 * unrelated checklists elsewhere in the body (Open Questions, Test Plan) from
 * being misread as ACs, while letting ordinary human-written issues parse.
 *
 * @param issueBody - The full GitHub issue body markdown
 * @returns Array of parsed acceptance criteria
 */
export function parseAcceptanceCriteria(
  issueBody: string,
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const seenIds = new Set<string>();

  const push = (id: string, description: string, evidence?: string): void => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    criteria.push(
      createAcceptanceCriterion(
        id,
        description,
        resolveVerificationMethod(description, evidence),
        evidence,
      ),
    );
  };

  // Split into lines and process each. `inAcSection` tracks whether the
  // current line falls under an `## Acceptance Criteria` heading; it toggles on
  // every heading and closes at the next heading of any level (same boundary
  // rule as `parseNonGoals` in ready-gate.ts). `bareCount` numbers synthesized
  // IDs for bare checkboxes in appearance order.
  const lines = issueBody.split("\n");
  let inAcSection = false;
  let bareCount = 0;

  // Pre-scan for explicit IDs anywhere in the body. Synthesis must skip IDs
  // owned by explicit markers even when the marker appears on a LATER line —
  // otherwise a bare checkbox listed before `**AC-1:**` under the same heading
  // synthesizes AC-1 first and the author's explicit AC-1 is silently dropped
  // by the first-occurrence dedupe.
  const explicitIds = new Set<string>();
  for (const line of lines) {
    const parsed = parseACLine(line);
    if (parsed) explicitIds.add(parsed.id);
  }

  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      inAcSection = AC_HEADING_RE.test(line);
      continue;
    }

    // Existing ID-prefixed patterns run on every line, regardless of section,
    // so previously-parsable issues are unaffected (AC-4).
    const parsed = parseACLine(line);
    if (parsed) {
      push(parsed.id, parsed.description, parsed.evidence);
      continue;
    }

    // Bare-checkbox fallback: only inside the AC section (AC-1/AC-2).
    if (inAcSection) {
      const bare = line.match(BARE_CHECKBOX_RE);
      const bareText = bare?.[1].trim();
      if (bareText) {
        const { description, evidence } = splitEvidenceClause(bareText);
        // Synthesize `AC-<n>`, skipping any ID already taken by an explicit
        // marker — before OR after this line — so a synthesized ID can never
        // collide with (and be silently dropped against) a hand-written one.
        let id: string;
        do {
          id = `AC-${++bareCount}`;
        } while (seenIds.has(id) || explicitIds.has(id));
        push(id, description, evidence);
      }
    }
  }

  return criteria;
}

/**
 * Extract and create full AcceptanceCriteria object from issue body
 *
 * This is the main entry point for the /spec skill to use.
 *
 * @param issueBody - The full GitHub issue body markdown
 * @returns Complete AcceptanceCriteria object with items and summary
 */
export function extractAcceptanceCriteria(
  issueBody: string,
): AcceptanceCriteria {
  const items = parseAcceptanceCriteria(issueBody);
  return createAcceptanceCriteria(items);
}

/**
 * Check if an issue body contains acceptance criteria
 *
 * @param issueBody - The full GitHub issue body markdown
 * @returns True if AC items are found
 */
export function hasAcceptanceCriteria(issueBody: string): boolean {
  const items = parseAcceptanceCriteria(issueBody);
  return items.length > 0;
}
