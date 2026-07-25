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

    // #808: the bold-ID-without-colon style matched none of the four original
    // patterns, so an issue written this way parsed as ZERO ACs — silently.
    it("should parse bold AC markers with no colon", () => {
      const issueBody = `
## Acceptance Criteria

- [ ] **AC-1** User can login with email and password
- [ ] **AC-2** Session persists across page refreshes
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[0].description).toBe(
        "User can login with email and password",
      );
      expect(criteria[1].id).toBe("AC-2");
      expect(criteria[1].description).toBe(
        "Session persists across page refreshes",
      );
    });

    it("should parse the no-colon letter-number form (e.g., B2)", () => {
      const criteria = parseAcceptanceCriteria(
        "- [ ] **B2** /spec extracts and stores ACs in state\n",
      );

      expect(criteria.length).toBe(1);
      expect(criteria[0].id).toBe("B2");
      expect(criteria[0].description).toBe(
        "/spec extracts and stores ACs in state",
      );
    });

    it("should parse a checked box with a no-colon bold marker", () => {
      const criteria = parseAcceptanceCriteria(
        "- [x] **AC-1** Completed criterion\n",
      );

      expect(criteria.length).toBe(1);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[0].description).toBe("Completed criterion");
    });

    it("should absorb a colon placed outside the bold markers", () => {
      const criteria = parseAcceptanceCriteria(
        "- [ ] **AC-1**: Description after an outside colon\n",
      );

      expect(criteria.length).toBe(1);
      expect(criteria[0].id).toBe("AC-1");
      // Without the `:?` in the pattern this would be ": Description after…".
      expect(criteria[0].description).toBe(
        "Description after an outside colon",
      );
    });

    it("should not treat a non-identifier bold label as an AC", () => {
      const issueBody = `
- [ ] **Note** this is just a checklist item
- [ ] **Verify** the deployment looks right
- [ ] **TODO** something else
`;

      expect(parseAcceptanceCriteria(issueBody)).toEqual([]);
    });

    it("should parse issue #803's body verbatim (regression fixture)", () => {
      // Copied unmodified from https://github.com/sequant-io/sequant/issues/803
      // as originally authored. This body produced 0 ACs before #808.
      const issueBody = `## Acceptance Criteria

- [ ] **AC-1** After assembling the combined state and before running test/build, \`combined-branch-test.ts\` reinstalls dependencies when the lockfile changed (compare lockfile vs the base, or install unconditionally). Use the **detected package manager** (this repo is pnpm; don't hardcode \`npm install\`).
- [ ] **AC-2** With deps reinstalled, a combined state whose branches only changed the lockfile (added a dep) reports \`npm test\`/\`npm run build\` **passed** — reproduce the #109-113-class scenario in a test/fixture and assert no false BLOCKED.
- [ ] **AC-3** When test/build genuinely fails, the finding message includes a **non-empty reason**: fall back to a stdout tail when stderr is empty (both truncated). No more \`failed on combined state: \` with nothing after it.
- [ ] **AC-4** Install failures themselves are surfaced distinctly (a bad merged lockfile → clear "dependency install failed" finding, not a downstream mystery test failure).
- [ ] **AC-5** Regression test covering: (a) lockfile-changed combined state passes after reinstall, (b) empty-stderr failure still yields a diagnosable message.
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.map((c) => c.id)).toEqual([
        "AC-1",
        "AC-2",
        "AC-3",
        "AC-4",
        "AC-5",
      ]);
      expect(criteria[3].description).toContain(
        "Install failures themselves are surfaced distinctly",
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

    it("should parse bold-wrapped ID + description format", () => {
      const issueBody = `
## Acceptance Criteria

- [ ] **AC-1: Stdio E2E — tool discovery.** A test spawns the MCP server
- [ ] **AC-2: Error handling for invalid input.** The server returns an error
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[0].description).toBe(
        "Stdio E2E — tool discovery. A test spawns the MCP server",
      );
      expect(criteria[1].id).toBe("AC-2");
      expect(criteria[1].description).toBe(
        "Error handling for invalid input. The server returns an error",
      );
    });

    it("should parse bold-wrapped format with no text after closing bold", () => {
      const issueBody = `
- [ ] **AC-1: Description only inside bold.**
- [ ] **AC-2: Another criterion.**
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[0].description).toBe("Description only inside bold.");
      expect(criteria[1].id).toBe("AC-2");
      expect(criteria[1].description).toBe("Another criterion.");
    });

    it("should parse bold-wrapped format from issue #414 (10 ACs)", () => {
      const issueBody = `
## Acceptance Criteria

- [ ] **AC-1: Stdio E2E — tool discovery.** A test spawns the server via stdio
- [ ] **AC-2: Stdio E2E — tool execution.** A test calls a tool
- [ ] **AC-3: Stdio E2E — resource listing.** Resources are listed
- [ ] **AC-4: HTTP+SSE E2E — tool discovery.** Same as AC-1 over HTTP
- [ ] **AC-5: HTTP+SSE E2E — tool execution.** Same as AC-2 over HTTP
- [ ] **AC-6: HTTP+SSE E2E — resource listing.** Same as AC-3 over HTTP
- [ ] **AC-7: Graceful shutdown.** SIGINT stops the server cleanly
- [ ] **AC-8: CI matrix.** Tests run in CI on Node 18 and 20
- [ ] **AC-9: Timeout guard.** Each test has a timeout
- [ ] **AC-10: No mocks.** Tests use real MCP client SDK
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(10);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[9].id).toBe("AC-10");
      expect(criteria[0].description).toBe(
        "Stdio E2E — tool discovery. A test spawns the server via stdio",
      );
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
