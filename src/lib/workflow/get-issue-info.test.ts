import { describe, it, expect } from "vitest";
import { getIssueInfo, issueTitleWarning } from "./batch-executor.js";
import { FakeGitHubProvider } from "./platforms/fake-github.js";
import {
  deriveGhFixture,
  loadGhFixture,
  type GhFixture,
} from "./platforms/gh-fixtures.js";

// #1257 AC-5: getIssueInfo used to turn every gh failure into the same silent
// "Issue #N" placeholder, so a dry run could not tell "this issue does not
// exist" from "gh is offline". Only gh's not-found error sets `notFound`.
// #1506: gh's output comes from captured fixtures, not a child_process mock.

const ISSUE = loadGhFixture("issue-view");
const NOT_FOUND = loadGhFixture("issue-view-not-found");
const HTTP_502 = loadGhFixture("pr-comment-http-502");

/** `gh issue view <n>` answered from `base`, for any issue number. */
function issueView(
  n: number,
  base: GhFixture,
  changes: Parameters<typeof deriveGhFixture>[1] = {},
): FakeGitHubProvider {
  return new FakeGitHubProvider(
    deriveGhFixture(base, {
      args: ISSUE.args.map((a) => (a === "1475" ? String(n) : a)),
      ...changes,
    }),
  );
}

describe("getIssueInfo (#1257)", () => {
  it("flags an issue number gh cannot resolve", async () => {
    expect(await getIssueInfo(404, issueView(404, NOT_FOUND))).toEqual({
      title: "Issue #404",
      labels: [],
      notFound: true,
    });
  });

  it("keeps the silent placeholder for any other gh failure", async () => {
    const offline = issueView(7, NOT_FOUND, {
      stderr: "error connecting to api.github.com\n",
    });
    const info = await getIssueInfo(7, offline);
    expect(info).toEqual({
      title: "Issue #7",
      labels: [],
      error: "error connecting to api.github.com",
    });
    expect(info).not.toHaveProperty("notFound");
  });

  it("returns the title and labels of an issue that exists", async () => {
    expect(await getIssueInfo(7, issueView(7, ISSUE))).toEqual({
      title: JSON.parse(ISSUE.stdout).title,
      labels: ["refactor", "planned", "graph-2026-10-consolidation"],
    });
  });
});

// #1487: the placeholder title used to be silent, so a run that then cut
// feature/N-issue-n from main gave no sign of why.
describe("title unreadable warning (#1487)", () => {
  it("names the issue and the gh error when gh fails with HTTP 502", async () => {
    const warning = issueTitleWarning(
      1305,
      await getIssueInfo(1305, issueView(1305, HTTP_502)),
    );
    expect(warning).toContain("#1305");
    expect(warning).toContain("HTTP 502");
  });

  it("prints nothing when gh read the title", async () => {
    expect(
      issueTitleWarning(1305, await getIssueInfo(1305, issueView(1305, ISSUE))),
    ).toBeNull();
  });

  it("prints nothing for an issue gh says does not exist", async () => {
    expect(
      issueTitleWarning(
        404,
        await getIssueInfo(404, issueView(404, NOT_FOUND)),
      ),
    ).toBeNull();
  });

  it("names the parse error when gh prints unparseable JSON", async () => {
    const garbled = issueView(9, ISSUE, { stdout: "not json" });
    const warning = issueTitleWarning(9, await getIssueInfo(9, garbled));
    expect(warning).toContain("#9");
    expect(warning).toMatch(/JSON/);
  });
});
