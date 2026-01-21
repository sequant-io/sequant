/**
 * Acceptance Criteria Parser
 *
 * Extracts acceptance criteria from GitHub issue markdown.
 * Supports checkbox format: `- [ ] **AC-1:** Description`
 * Also supports alternate formats: `- [ ] **B2:** Description`
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
 */
const AC_PATTERNS = [
  // Pattern 1: `- [ ] **AC-1:** Description` or `- [x] **AC-1:** Description`
  /^-\s*\[[x\s]\]\s*\*\*([A-Za-z]+-?\d+):\*\*\s*(.+)$/gim,
  // Pattern 2: `- [ ] **B2:** Description` (letter + number without hyphen)
  /^-\s*\[[x\s]\]\s*\*\*([A-Za-z]\d+):\*\*\s*(.+)$/gim,
  // Pattern 3: `- [ ] AC-1: Description` (no bold)
  /^-\s*\[[x\s]\]\s*([A-Za-z]+-?\d+):\s*(.+)$/gim,
];

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
      return {
        id: match[1].toUpperCase(),
        description: match[2].trim(),
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
 * - `- [ ] AC-1: Description`
 *
 * @param issueBody - The full GitHub issue body markdown
 * @returns Array of parsed acceptance criteria
 */
export function parseAcceptanceCriteria(
  issueBody: string,
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const seenIds = new Set<string>();

  // Split into lines and process each
  const lines = issueBody.split("\n");

  for (const line of lines) {
    const parsed = parseACLine(line);
    if (parsed && !seenIds.has(parsed.id)) {
      seenIds.add(parsed.id);
      const verificationMethod = inferVerificationMethod(parsed.description);
      criteria.push(
        createAcceptanceCriterion(
          parsed.id,
          parsed.description,
          verificationMethod,
        ),
      );
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
