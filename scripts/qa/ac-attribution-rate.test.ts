import { describe, it, expect, vi } from "vitest";

import { FakeGitHubProvider } from "../../src/lib/workflow/platforms/fake-github.js";
import {
  deriveGhFixture,
  loadGhFixture,
} from "../../src/lib/workflow/platforms/gh-fixtures.js";
import { main, measureAttribution } from "./ac-attribution-rate.js";

const BODY = [
  "## Acceptance Criteria",
  "- [ ] AC-1: a. Evidence: `npx vitest run src/a.test.ts` → passes",
  "- [ ] AC-2: b. Evidence: a human agrees",
  "- [ ] AC-3: c",
].join("\n");

describe("ac-attribution-rate", () => {
  it("counts ACs whose evidence names a path", () => {
    expect(measureAttribution([{ body: BODY }], "2026-09-20")).toEqual({
      closedSince: "2026-09-20",
      issues: 1,
      acs: 3,
      withEvidence: 2,
      attributed: 1,
      rate: 0.333,
    });
  });

  it("--json prints acs and a numeric rate from the provider's closed issues", () => {
    const captured = loadGhFixture("issue-list-closed-with-body");
    const fixture = deriveGhFixture(captured, {
      args: captured.args.map((a) =>
        a === "closed:>=2026-10-20"
          ? "closed:>=2026-09-20"
          : a === "2"
            ? "1000"
            : a,
      ),
      json: () => [{ number: 1, closedAt: "2026-09-21T00:00:00Z", body: BODY }],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = main(
      ["--closed-since", "2026-09-20", "--json"],
      new FakeGitHubProvider(fixture),
    );
    const report = JSON.parse(log.mock.calls[0][0] as string);
    log.mockRestore();
    expect(code).toBe(0);
    expect(report.acs).toBe(3);
    expect(typeof report.rate).toBe("number");
  });

  it("parses the captured closed-issue list", () => {
    const report = measureAttribution(
      new FakeGitHubProvider(
        loadGhFixture("issue-list-closed-with-body"),
      ).listClosedIssuesWithBodySync("2026-10-20", 2),
      "2026-10-20",
    );
    expect(report.issues).toBe(2);
    expect(report.acs).toBeGreaterThan(0);
  });

  it("rejects a missing date", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main([], new FakeGitHubProvider())).toBe(2);
    err.mockRestore();
  });
});
