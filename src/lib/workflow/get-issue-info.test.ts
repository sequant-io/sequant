import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "child_process";
import { getIssueInfo } from "./batch-executor.js";

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
    expect(info).toEqual({ title: "Issue #7", labels: [] });
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
