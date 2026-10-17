import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "child_process";
import { getIssueInfo, issueTitleWarning } from "./batch-executor.js";

// #1257 AC-5: getIssueInfo used to turn every gh failure into the same silent
// "Issue #N" placeholder, so a dry run could not tell "this issue does not
// exist" from "gh is offline". Only gh's not-found error sets `notFound`.

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

function ghResult(status: number, stdout: string, stderr: string) {
  return {
    status,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  } as unknown as ReturnType<typeof spawnSync>;
}

describe("getIssueInfo (#1257)", () => {
  beforeEach(() => vi.mocked(spawnSync).mockReset());

  it("flags an issue number gh cannot resolve", async () => {
    vi.mocked(spawnSync).mockReturnValue(
      ghResult(
        1,
        "",
        "GraphQL: Could not resolve to an issue or pull request with the number of 404. (repository.issue)\n",
      ),
    );
    expect(await getIssueInfo(404)).toEqual({
      title: "Issue #404",
      labels: [],
      notFound: true,
    });
  });

  it("keeps the silent placeholder for any other gh failure", async () => {
    vi.mocked(spawnSync).mockReturnValue(
      ghResult(1, "", "error connecting to api.github.com\n"),
    );
    const info = await getIssueInfo(7);
    expect(info).toEqual({
      title: "Issue #7",
      labels: [],
      error: "error connecting to api.github.com",
    });
    expect(info).not.toHaveProperty("notFound");
  });

  it("returns the title and labels of an issue that exists", async () => {
    vi.mocked(spawnSync).mockReturnValue(
      ghResult(
        0,
        JSON.stringify({ title: "Real issue", labels: [{ name: "bug" }] }),
        "",
      ),
    );
    expect(await getIssueInfo(7)).toEqual({
      title: "Real issue",
      labels: ["bug"],
    });
  });
});

// #1487: the placeholder title used to be silent, so a run that then cut
// feature/N-issue-n from main gave no sign of why.
describe("title unreadable warning (#1487)", () => {
  beforeEach(() => vi.mocked(spawnSync).mockReset());

  it("names the issue and the gh error when gh fails with HTTP 502", async () => {
    vi.mocked(spawnSync).mockReturnValue(
      ghResult(
        1,
        "",
        "HTTP 502: Bad Gateway (https://api.github.com/graphql)\n",
      ),
    );
    const warning = issueTitleWarning(1305, await getIssueInfo(1305));
    expect(warning).toContain("#1305");
    expect(warning).toContain("HTTP 502");
  });

  it("prints nothing when gh read the title", async () => {
    vi.mocked(spawnSync).mockReturnValue(
      ghResult(0, JSON.stringify({ title: "Real issue", labels: [] }), ""),
    );
    expect(issueTitleWarning(1305, await getIssueInfo(1305))).toBeNull();
  });

  it("prints nothing for an issue gh says does not exist", async () => {
    vi.mocked(spawnSync).mockReturnValue(
      ghResult(
        1,
        "",
        "GraphQL: Could not resolve to an issue or pull request with the number of 404.\n",
      ),
    );
    expect(issueTitleWarning(404, await getIssueInfo(404))).toBeNull();
  });

  it("names the parse error when gh prints unparseable JSON", async () => {
    vi.mocked(spawnSync).mockReturnValue(ghResult(0, "not json", ""));
    const warning = issueTitleWarning(9, await getIssueInfo(9));
    expect(warning).toContain("#9");
    expect(warning).toMatch(/JSON/);
  });
});
