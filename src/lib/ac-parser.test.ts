/**
 * Tests for AC Parser
 */

import { describe, it, expect } from "vitest";
import {
  parseAcceptanceCriteria,
  extractAcceptanceCriteria,
  hasAcceptanceCriteria,
  inferVerificationMethod,
} from "./ac-parser.js";

describe("AC Parser", () => {
  describe("parseAcceptanceCriteria", () => {
    it("should parse standard AC format with bold markers", () => {
      const issueBody = `
## Acceptance Criteria

- [ ] **AC-1:** User can login with email and password
- [ ] **AC-2:** Session persists across page refreshes
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[0].description).toBe(
        "User can login with email and password",
      );
      expect(criteria[0].status).toBe("pending");
      expect(criteria[1].id).toBe("AC-2");
      expect(criteria[1].description).toBe(
        "Session persists across page refreshes",
      );
    });

    it("should parse letter-number format (e.g., B2)", () => {
      const issueBody = `
## Acceptance Criteria

- [ ] **B2:** /spec extracts and stores ACs in state
- [ ] **B3:** /qa updates AC status during review
- [ ] **B4:** Dashboard displays AC checklist
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(3);
      expect(criteria[0].id).toBe("B2");
      expect(criteria[1].id).toBe("B3");
      expect(criteria[2].id).toBe("B4");
    });

    it("should handle checked checkboxes", () => {
      const issueBody = `
- [x] **AC-1:** Completed criterion
- [ ] **AC-2:** Pending criterion
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[1].id).toBe("AC-2");
    });

    it("should handle format without bold markers", () => {
      const issueBody = `
- [ ] AC-1: User can login
- [ ] AC-2: User can logout
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[0].description).toBe("User can login");
    });

    it("should normalize IDs to uppercase", () => {
      const issueBody = `
- [ ] **ac-1:** Lowercase ID
- [ ] **Ac-2:** Mixed case ID
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[1].id).toBe("AC-2");
    });

    it("should ignore duplicate IDs", () => {
      const issueBody = `
- [ ] **AC-1:** First occurrence
- [ ] **AC-1:** Duplicate should be ignored
- [ ] **AC-2:** Different ID
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].description).toBe("First occurrence");
      expect(criteria[1].id).toBe("AC-2");
    });

    it("should return empty array for issue without AC", () => {
      const issueBody = `
## Summary

This is just a summary without acceptance criteria.

## Tasks

- [ ] Task 1
- [ ] Task 2
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(0);
    });

    it("should handle mixed content", () => {
      const issueBody = `
## Summary

Follow-up to #139.

## Acceptance Criteria

- [ ] **B2:** /spec extracts and stores ACs in state
  - Parse ACs from issue body
  - Store in state manager

- [ ] **B3:** /qa updates AC status
  - Update each item's status

## Implementation Notes

Some notes here.
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].id).toBe("B2");
      expect(criteria[1].id).toBe("B3");
    });
  });

  describe("inferVerificationMethod", () => {
    it("should infer unit_test from keywords", () => {
      expect(inferVerificationMethod("Unit test for login")).toBe("unit_test");
      expect(inferVerificationMethod("unittest validates input")).toBe(
        "unit_test",
      );
    });

    it("should infer integration_test from keywords", () => {
      expect(inferVerificationMethod("API endpoint returns 200")).toBe(
        "integration_test",
      );
      expect(inferVerificationMethod("Integration with database")).toBe(
        "integration_test",
      );
    });

    it("should infer browser_test from keywords", () => {
      expect(inferVerificationMethod("Display user name in header")).toBe(
        "browser_test",
      );
      expect(inferVerificationMethod("Dashboard shows metrics")).toBe(
        "browser_test",
      );
      expect(inferVerificationMethod("E2E test for checkout")).toBe(
        "browser_test",
      );
      expect(inferVerificationMethod("Click button to submit")).toBe(
        "browser_test",
      );
      expect(inferVerificationMethod("Navigate to settings page")).toBe(
        "browser_test",
      );
      expect(inferVerificationMethod("UI shows error message")).toBe(
        "browser_test",
      );
    });

    it("should default to manual for generic descriptions", () => {
      expect(inferVerificationMethod("User can login")).toBe("manual");
      expect(inferVerificationMethod("System processes data")).toBe("manual");
    });

    it("should be case insensitive", () => {
      expect(inferVerificationMethod("UNIT TEST for validation")).toBe(
        "unit_test",
      );
      expect(inferVerificationMethod("DASHBOARD shows data")).toBe(
        "browser_test",
      );
    });
  });

  describe("extractAcceptanceCriteria", () => {
    it("should return full AcceptanceCriteria object", () => {
      const issueBody = `
- [ ] **AC-1:** User can login
- [ ] **AC-2:** User can logout
`;

      const ac = extractAcceptanceCriteria(issueBody);

      expect(ac.items.length).toBe(2);
      expect(ac.extractedAt).toBeDefined();
      expect(ac.summary.total).toBe(2);
      expect(ac.summary.pending).toBe(2);
      expect(ac.summary.met).toBe(0);
      expect(ac.summary.notMet).toBe(0);
      expect(ac.summary.blocked).toBe(0);
    });

    it("should return empty AC for no criteria", () => {
      const ac = extractAcceptanceCriteria("No criteria here");

      expect(ac.items.length).toBe(0);
      expect(ac.summary.total).toBe(0);
    });
  });

  describe("hasAcceptanceCriteria", () => {
    it("should return true when AC exists", () => {
      const issueBody = `
- [ ] **AC-1:** User can login
`;
      expect(hasAcceptanceCriteria(issueBody)).toBe(true);
    });

    it("should return false when no AC exists", () => {
      expect(hasAcceptanceCriteria("No criteria")).toBe(false);
    });
  });
});
