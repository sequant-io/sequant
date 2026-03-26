import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync, spawnSync } from "child_process";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);
const mockSpawnSync = vi.mocked(spawnSync);

import { GitHubProvider } from "./github.js";

describe("GitHubProvider", () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GitHubProvider();
  });

  it("has name 'github'", () => {
    expect(provider.name).toBe("github");
  });

  it("implements PlatformProvider interface", () => {
    expect(typeof provider.fetchIssue).toBe("function");
    expect(typeof provider.postComment).toBe("function");
    expect(typeof provider.addLabel).toBe("function");
    expect(typeof provider.removeLabel).toBe("function");
    expect(typeof provider.createPR).toBe("function");
    expect(typeof provider.getPRStatus).toBe("function");
    expect(typeof provider.postPRComment).toBe("function");
    expect(typeof provider.checkAuth).toBe("function");
    expect(typeof provider.getIssueComments).toBe("function");
  });

  describe("checkAuth", () => {
    it("returns true when gh auth status succeeds", async () => {
      mockExecSync.mockReturnValue("" as never);
      const result = await provider.checkAuth();
      expect(result).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("gh auth status", {
        stdio: "ignore",
      });
    });

    it("returns false when gh auth status fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not authenticated");
      });
      const result = await provider.checkAuth();
      expect(result).toBe(false);
    });
  });

  describe("getIssueComments", () => {
    it("returns comments on success", async () => {
      const mockComments = [
        { body: "comment 1", createdAt: "2026-01-01T00:00:00Z" },
        { body: "comment 2", createdAt: "2026-01-02T00:00:00Z" },
      ];
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify(mockComments),
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      const result = await provider.getIssueComments("123");
      expect(result).toEqual(mockComments);
    });

    it("returns empty array on failure", async () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      const result = await provider.getIssueComments("123");
      expect(result).toEqual([]);
    });
  });

  describe("fetchIssueTitleSync", () => {
    it("returns title on success", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "My issue title\n",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.fetchIssueTitleSync("42")).toBe("My issue title");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "gh",
        ["issue", "view", "42", "--json", "title", "--jq", ".title"],
        expect.objectContaining({ encoding: "utf-8", timeout: 10000 }),
      );
    });

    it("returns null on failure", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.fetchIssueTitleSync("999")).toBeNull();
    });

    it("returns null on empty output", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "  \n",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.fetchIssueTitleSync("1")).toBeNull();
    });
  });

  describe("checkGhInstalledSync", () => {
    it("returns true when gh --version succeeds", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "gh version 2.40.0",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.checkGhInstalledSync()).toBe(true);
    });

    it("returns false when gh --version fails", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.checkGhInstalledSync()).toBe(false);
    });
  });

  describe("fetchReleaseSync", () => {
    it("returns parsed release data on success", () => {
      const release = {
        tagName: "v1.0.0",
        name: "v1.0.0",
        body: "notes",
        publishedAt: "2026-01-01",
      };
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify(release),
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.fetchReleaseSync("owner/repo", "v1.0.0")).toEqual(
        release,
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "gh",
        [
          "release",
          "view",
          "v1.0.0",
          "--repo",
          "owner/repo",
          "--json",
          "tagName,name,body,publishedAt",
        ],
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("fetches latest when no version given", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({ tagName: "v2.0.0" }),
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      provider.fetchReleaseSync("owner/repo");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "gh",
        [
          "release",
          "view",
          "--repo",
          "owner/repo",
          "--json",
          "tagName,name,body,publishedAt",
        ],
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("returns null on failure", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "not found",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.fetchReleaseSync("owner/repo", "v0.0.0")).toBeNull();
    });
  });

  describe("listReleasesSync", () => {
    it("returns parsed releases on success", () => {
      const releases = [
        { tagName: "v2.0.0", publishedAt: "2026-02-01" },
        { tagName: "v1.0.0", publishedAt: "2026-01-01" },
      ];
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify(releases),
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.listReleasesSync("owner/repo", 10)).toEqual(releases);
    });

    it("returns empty array on failure", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.listReleasesSync("owner/repo")).toEqual([]);
    });
  });

  describe("searchIssuesSync", () => {
    it("returns matching issues on success", () => {
      const issues = [{ number: 1, title: "Test issue" }];
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify(issues),
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(
        provider.searchIssuesSync("owner/repo", ["upstream"], "test", 5),
      ).toEqual(issues);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          "owner/repo",
          "--label",
          "upstream",
          "--search",
          "test",
          "--json",
          "number,title",
          "--limit",
          "5",
        ],
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("returns empty array on failure", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.searchIssuesSync("owner/repo", [], "q")).toEqual([]);
    });
  });

  describe("createIssueWithBodyFileSync", () => {
    it("returns issue info on success", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "https://github.com/owner/repo/issues/42\n",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      const result = provider.createIssueWithBodyFileSync(
        "owner/repo",
        "title",
        "/tmp/body.md",
        ["bug"],
      );
      expect(result).toEqual({
        number: 42,
        url: "https://github.com/owner/repo/issues/42",
      });
    });

    it("returns null on failure", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(
        provider.createIssueWithBodyFileSync(
          "owner/repo",
          "title",
          "/tmp/body.md",
          [],
        ),
      ).toBeNull();
    });
  });

  describe("commentOnIssueWithBodyFileSync", () => {
    it("returns true on success", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(
        provider.commentOnIssueWithBodyFileSync(
          "owner/repo",
          42,
          "/tmp/comment.md",
        ),
      ).toBe(true);
    });

    it("returns false on failure", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(
        provider.commentOnIssueWithBodyFileSync(
          "owner/repo",
          42,
          "/tmp/comment.md",
        ),
      ).toBe(false);
    });
  });

  describe("getPRHeadBranchSync", () => {
    it("returns branch name on success", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "feature/123-my-feature\n",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      const result = provider.getPRHeadBranchSync(123);
      expect(result).toBe("feature/123-my-feature");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "gh",
        ["pr", "view", "123", "--json", "headRefName", "--jq", ".headRefName"],
        expect.objectContaining({ stdio: "pipe", timeout: 10000 }),
      );
    });

    it("returns null on failure", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.getPRHeadBranchSync(999)).toBeNull();
    });

    it("returns null on empty output", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      } as never);
      expect(provider.getPRHeadBranchSync(456)).toBeNull();
    });
  });
});
