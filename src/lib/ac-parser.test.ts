/**
 * Tests for AC Parser
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseAcceptanceCriteria,
  extractAcceptanceCriteria,
  hasAcceptanceCriteria,
  inferVerificationMethod,
} from "./ac-parser.js";

// Real, unmodified GitHub issue bodies committed under __fixtures__ so the
// tests are hermetic (no network). See issue #850.
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "ac-parser",
);
const readFixture = (issue: number): string =>
  readFileSync(join(FIXTURE_DIR, `issue-${issue}.md`), "utf8");

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

  // #850: human-written issues rarely prefix their ACs with IDs, so before
  // this every hand-authored issue parsed to zero ACs. Bare checkbox items are
  // now honored, but ONLY under an explicit `## Acceptance Criteria` heading.
  describe("bare-checkbox ACs under an Acceptance Criteria heading (#850)", () => {
    // AC-1: bare checkboxes under the heading parse with synthesized stable IDs
    it("parses bare checkboxes under the heading with synthesized IDs", () => {
      const issueBody = `## Acceptance Criteria

- [ ] An npm run gen-types script writes the generated section
- [ ] Custom aliases are preserved
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
      expect(criteria[0].description).toBe(
        "An npm run gen-types script writes the generated section",
      );
      expect(criteria[1].description).toBe("Custom aliases are preserved");
    });

    // AC-1: IDs must be deterministic across re-parses of the same body
    it("synthesizes IDs deterministically across re-parses", () => {
      const issueBody = `## Acceptance Criteria

- [ ] First requirement
- [ ] Second requirement
`;

      const first = parseAcceptanceCriteria(issueBody).map((c) => c.id);
      const second = parseAcceptanceCriteria(issueBody).map((c) => c.id);

      expect(first).toEqual(second);
      expect(first).toEqual(["AC-1", "AC-2"]);
    });

    // AC-1: heading match is case-insensitive (real issue #703 uses lowercase)
    it("matches the heading case-insensitively", () => {
      const issueBody = `## Acceptance criteria

- [ ] Lowercase-heading requirement
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(1);
      expect(criteria[0].id).toBe("AC-1");
    });

    // AC-1: a synthesized ID must never collide with an explicit AC-N on
    // another line (the seenIds dedupe would otherwise silently drop it).
    it("skips IDs already taken by explicit markers to avoid collisions", () => {
      const issueBody = `## Acceptance Criteria

- [ ] **AC-1:** Explicit first criterion
- [ ] A bare criterion that must not collide with AC-1
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(2);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[0].description).toBe("Explicit first criterion");
      // Synthesized ID skips the taken AC-1 rather than being dropped.
      expect(criteria[1].id).toBe("AC-2");
      expect(criteria[1].description).toBe(
        "A bare criterion that must not collide with AC-1",
      );
    });

    // AC-2: bare checkboxes with NO AC heading anywhere are not misread as ACs
    it("ignores bare checkboxes when there is no AC heading", () => {
      const issueBody = `## Open questions

- [ ] Should we cache the result?
- [ ] What is the frequency floor?

## Test plan

- [ ] Manual smoke test
`;

      expect(parseAcceptanceCriteria(issueBody)).toEqual([]);
    });

    // AC-2: the AC section closes at the next heading — later checklists are
    // not swept in.
    it("stops honoring bare checkboxes at the next heading", () => {
      const issueBody = `## Acceptance Criteria

- [ ] The one real criterion

## Open questions

- [ ] Not an AC
- [ ] Also not an AC
`;

      const criteria = parseAcceptanceCriteria(issueBody);

      expect(criteria.length).toBe(1);
      expect(criteria[0].id).toBe("AC-1");
      expect(criteria[0].description).toBe("The one real criterion");
    });

    // AC-3: real matcha-maps issue bodies parse to their expected counts.
    // Positive fixtures exercise the new bare-checkbox path; #745 exercises the
    // existing ID path (it was rewritten to `**AC-N:**` form as a workaround —
    // see its own <sub> note referencing #850); #750 is the AC-2 negative case.
    it("parses real bare-checkbox issue #686 to 4 ACs", () => {
      const criteria = parseAcceptanceCriteria(readFixture(686));
      expect(criteria.length).toBe(4);
      expect(criteria.map((c) => c.id)).toEqual([
        "AC-1",
        "AC-2",
        "AC-3",
        "AC-4",
      ]);
    });

    it("parses real lowercase-heading issue #703 to 2 ACs", () => {
      const criteria = parseAcceptanceCriteria(readFixture(703));
      expect(criteria.length).toBe(2);
      expect(criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    });

    it("parses real ID-prefixed issue #745 to a non-zero count", () => {
      // #745 was rewritten into `**AC-N:**` form; it validates that the
      // existing ID path still yields a non-zero count (AC-3 + AC-4).
      const criteria = parseAcceptanceCriteria(readFixture(745));
      expect(criteria.length).toBeGreaterThan(0);
      expect(criteria.length).toBe(6);
    });

    // AC-2 (negative): #750 has NO `## Acceptance Criteria` heading — only
    // `## Open questions ...` bare checkboxes — so it must parse to zero. This
    // resolves the AC-2-vs-AC-3 contradiction the spec surfaced (Q2): AC-2 is
    // the actual requirement; a non-zero here would re-open the "any checklist
    // is an AC" ambiguity the parser is meant to guard against.
    it("parses real headingless issue #750 to zero ACs (AC-2 guard)", () => {
      expect(parseAcceptanceCriteria(readFixture(750))).toEqual([]);
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
