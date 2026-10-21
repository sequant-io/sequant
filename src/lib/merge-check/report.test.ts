import { describe, it, expect, vi, afterEach } from "vitest";

import { buildReport, postReportToGitHub } from "./report.js";
import type { BranchInfo } from "./types.js";
import { FakeGitHubProvider } from "../workflow/platforms/fake-github.js";
import { loadGhFixture } from "../workflow/platforms/gh-fixtures.js";

// #1506: --post goes through provider.postPRComment; gh's answers are fixtures.

const branch = (issueNumber: number, prNumber?: number): BranchInfo => ({
  issueNumber,
  title: `Issue ${issueNumber}`,
  branch: `feature/${issueNumber}`,
  prNumber,
  filesModified: [],
});

describe("postReportToGitHub", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts one comment per branch that has a PR", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("pr-comment"));
    await postReportToGitHub(
      buildReport([branch(1475, 1563), branch(9)], []),
      fake,
    );
    expect(fake.calls.map((c) => c.args.slice(0, 3))).toEqual([
      ["pr", "comment", "1563"],
    ]);
    expect(fake.calls[0].args[4]).toContain("#1475");
  });

  it.each([
    ["pr-comment-http-502", "HTTP 502: Bad Gateway"],
    ["pr-comment-timeout", "ETIMEDOUT"],
    ["pr-comment-gh-missing", "ENOENT"],
  ])(
    "logs a never-empty reason when gh fails (%s, #803)",
    async (name, reason) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const fake = new FakeGitHubProvider(loadGhFixture(name));
      await postReportToGitHub(buildReport([branch(1475, 1563)], []), fake);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toMatch(
        new RegExp(`Failed to post comment on PR #1563: .*${reason}`),
      );
    },
  );
});
