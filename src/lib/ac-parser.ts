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
 * Parse a single line and extract AC if present
 *
 * @param line - A single line from the issue body
 * @returns Parsed AC or null if line doesn't match
 */
function parseACLine(line: string): { id: string; description: string } | null {
  for (const pattern of AC_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    if (match) {
      // Combine groups 2 and 3 for bold-wrapped format (Pattern 3)
      // where group 3 captures optional text after closing **
      const description = match[3]
        ? `${match[2].trim()} ${match[3].trim()}`.trim()
        : match[2].trim();
      return {
        id: match[1].toUpperCase(),
        description,
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

  const push = (id: string, description: string): void => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    criteria.push(
      createAcceptanceCriterion(
        id,
        description,
        inferVerificationMethod(description),
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
      push(parsed.id, parsed.description);
      continue;
    }

    // Bare-checkbox fallback: only inside the AC section (AC-1/AC-2).
    if (inAcSection) {
      const bare = line.match(BARE_CHECKBOX_RE);
      const description = bare?.[1].trim();
      if (description) {
        // Synthesize `AC-<n>`, skipping any ID already taken by an explicit
        // marker — before OR after this line — so a synthesized ID can never
        // collide with (and be silently dropped against) a hand-written one.
        let id: string;
        do {
          id = `AC-${++bareCount}`;
        } while (seenIds.has(id) || explicitIds.has(id));
        push(id, description);
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
