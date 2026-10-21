import { describe, it, expect } from "vitest";

import { GitHubProvider } from "./github.js";
import { FakeGitHubProvider } from "./fake-github.js";
import {
  deriveGhFixture,
  loadGhFixture,
  type GhFixture,
} from "./gh-fixtures.js";

// #1506: every case replays captured gh output through the provider's runner
// seam; no case fakes gh through child_process.

const REPO = "sequant-io/sequant";
const NOT_FOUND = loadGhFixture("issue-view-not-found");

/** The captured fixture, failing the way gh fails for a missing issue. */
function failing(base: GhFixture, args: string[] = base.args): GhFixture {
  return deriveGhFixture(base, {
    args,
    exitCode: NOT_FOUND.exitCode,
    stdout: "",
    stderr: NOT_FOUND.stderr,
  });
}

describe("GitHubProvider", () => {
  it("has name 'github'", () => {
    expect(new GitHubProvider().name).toBe("github");
  });

  it("implements PlatformProvider interface", () => {
    const provider = new GitHubProvider();
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
    it("returns true when gh auth status succeeds, under the 10s probe bound", async () => {
      const fake = new FakeGitHubProvider(loadGhFixture("auth-status"));
      expect(await fake.checkAuth()).toBe(true);
      expect(fake.calls[0]).toEqual({
        args: ["auth", "status"],
        opts: { timeout: 10_000 },
      });
    });

    it("returns false when gh auth status fails", async () => {
      const fake = new FakeGitHubProvider(
        loadGhFixture("auth-status-logged-out"),
      );
      expect(await fake.checkAuth()).toBe(false);
    });
  });

  describe("getIssueComments", () => {
    it("returns comments on success", async () => {
      const fixture = loadGhFixture("issue-comments");
      const fake = new FakeGitHubProvider(fixture);
      expect(await fake.getIssueComments("1475")).toEqual(
        JSON.parse(fixture.stdout),
      );
    });

    it("rejects on failure instead of resolving [] (#1315)", async () => {
      const fake = new FakeGitHubProvider(
        failing(loadGhFixture("issue-comments")),
      );
      await expect(fake.getIssueComments("1475")).rejects.toThrow(
        /gh issue view failed \(exit 1\): GraphQL: Could not resolve/,
      );
    });
  });

  describe("fetchIssueTitleSync", () => {
    const title = loadGhFixture("issue-view-title");

    it("returns title on success", () => {
      const fake = new FakeGitHubProvider(title);
      expect(fake.fetchIssueTitleSync("1475")).toBe(title.stdout.trim());
      expect(fake.calls[0].opts).toEqual({ timeout: 10000 });
    });

    it("returns null on failure", () => {
      expect(
        new FakeGitHubProvider(failing(title)).fetchIssueTitleSync("1475"),
      ).toBeNull();
    });

    it("returns null on empty output", () => {
      const blank = deriveGhFixture(title, { stdout: "  \n" });
      expect(
        new FakeGitHubProvider(blank).fetchIssueTitleSync("1475"),
      ).toBeNull();
    });
  });

  describe("checkGhInstalledSync", () => {
    it("returns true when gh --version succeeds", () => {
      expect(
        new FakeGitHubProvider(
          loadGhFixture("gh-version"),
        ).checkGhInstalledSync(),
      ).toBe(true);
    });

    it("returns false when gh is not installed", () => {
      const missing = deriveGhFixture(loadGhFixture("pr-comment-gh-missing"), {
        args: ["--version"],
      });
      expect(new FakeGitHubProvider(missing).checkGhInstalledSync()).toBe(
        false,
      );
    });
  });

  describe("fetchReleaseSync", () => {
    const latest = loadGhFixture("release-view-latest");

    it("returns the latest release when no version is given", () => {
      const release = new FakeGitHubProvider(latest).fetchReleaseSync(REPO);
      expect(release).toEqual(JSON.parse(latest.stdout));
      expect(release?.tagName).toMatch(/^v\d+\.\d+\.\d+$/);
    });

    it("passes the version before --repo", () => {
      const tagged = deriveGhFixture(latest, {
        args: [
          "release",
          "view",
          "v2.20.0",
          "--repo",
          REPO,
          "--json",
          "tagName,name,body,publishedAt",
        ],
      });
      expect(
        new FakeGitHubProvider(tagged).fetchReleaseSync(REPO, "v2.20.0"),
      ).not.toBeNull();
    });

    it("returns null on failure", () => {
      expect(
        new FakeGitHubProvider(failing(latest)).fetchReleaseSync(REPO),
      ).toBeNull();
    });
  });

  describe("listReleasesSync", () => {
    const list = loadGhFixture("release-list");

    it("returns parsed releases on success", () => {
      expect(new FakeGitHubProvider(list).listReleasesSync(REPO, 3)).toEqual(
        JSON.parse(list.stdout),
      );
    });

    it("returns empty array on failure", () => {
      expect(
        new FakeGitHubProvider(failing(list)).listReleasesSync(REPO, 3),
      ).toEqual([]);
    });
  });

  describe("searchIssuesSync", () => {
    const search = loadGhFixture("issue-search");

    it("returns matching issues on success", () => {
      expect(
        new FakeGitHubProvider(search).searchIssuesSync(
          REPO,
          ["planned"],
          "PlatformProvider",
          5,
        ),
      ).toEqual(JSON.parse(search.stdout));
    });

    it("returns empty array on failure", () => {
      expect(
        new FakeGitHubProvider(failing(search)).searchIssuesSync(
          REPO,
          ["planned"],
          "PlatformProvider",
          5,
        ),
      ).toEqual([]);
    });

    it("searchIssuesOrNullSync returns null on failure (#1179)", () => {
      expect(
        new FakeGitHubProvider(failing(search)).searchIssuesOrNullSync(
          REPO,
          ["planned"],
          "PlatformProvider",
          5,
        ),
      ).toBeNull();
    });
  });

  describe("listLabelsSync", () => {
    const labels = loadGhFixture("label-list");

    it("returns label names on success", () => {
      const names = new FakeGitHubProvider(labels).listLabelsSync(REPO);
      expect(names).toContain("bug");
      expect(names).toContain("refactor");
    });

    it("returns null on failure, not an empty list", () => {
      expect(
        new FakeGitHubProvider(failing(labels)).listLabelsSync(REPO),
      ).toBeNull();
    });
  });

  describe("createIssueWithBodyFileSync", () => {
    const created = loadGhFixture("issue-create-body-file");

    it("returns issue info on success", () => {
      const withLabel = deriveGhFixture(created, {
        args: [...created.args, "--label", "bug"],
      });
      expect(
        new FakeGitHubProvider(withLabel).createIssueWithBodyFileSync(
          REPO,
          "title",
          "/tmp/body.md",
          ["bug"],
        ),
      ).toEqual({
        number: 1600,
        url: "https://github.com/sequant-io/sequant/issues/1600",
      });
    });

    it("returns null on failure", () => {
      expect(
        new FakeGitHubProvider(failing(created)).createIssueWithBodyFileSync(
          REPO,
          "title",
          "/tmp/body.md",
          [],
        ),
      ).toBeNull();
    });
  });

  describe("commentOnIssueWithBodyFileSync", () => {
    const comment = loadGhFixture("issue-comment-body-file");

    it("returns true on success", () => {
      expect(
        new FakeGitHubProvider(comment).commentOnIssueWithBodyFileSync(
          REPO,
          1475,
          "/tmp/comment.md",
        ),
      ).toBe(true);
    });

    it("returns false on failure", () => {
      expect(
        new FakeGitHubProvider(failing(comment)).commentOnIssueWithBodyFileSync(
          REPO,
          1475,
          "/tmp/comment.md",
        ),
      ).toBe(false);
    });
  });

  describe("getPRHeadBranchSync", () => {
    const head = loadGhFixture("pr-view-head-branch");

    it("returns branch name on success", () => {
      const fake = new FakeGitHubProvider(head);
      expect(fake.getPRHeadBranchSync(1563)).toBe(head.stdout.trim());
      expect(fake.calls[0].opts).toEqual({ timeout: 10000 });
    });

    it("returns null on failure", () => {
      expect(
        new FakeGitHubProvider(failing(head)).getPRHeadBranchSync(1563),
      ).toBeNull();
    });

    it("returns null on empty output", () => {
      const blank = deriveGhFixture(head, { stdout: "" });
      expect(
        new FakeGitHubProvider(blank).getPRHeadBranchSync(1563),
      ).toBeNull();
    });
  });

  describe("updatePRSync (#1247)", () => {
    const update = loadGhFixture("pr-update");

    it("PATCHes the pull via gh api with the fields as JSON on stdin", () => {
      const fake = new FakeGitHubProvider(update);
      const result = fake.updatePRSync(
        1563,
        {
          title: "fix(#1): t",
          body: "line `x`\n$(not run)",
          base: "feature/0",
        },
        "/wt",
      );

      expect(result).toEqual({ success: true });
      const [{ args, opts }] = fake.calls;
      expect(args).not.toContain("edit");
      expect(opts.cwd).toBe("/wt");
      expect(JSON.parse(opts.input ?? "")).toEqual({
        title: "fix(#1): t",
        body: "line `x`\n$(not run)",
        base: "feature/0",
      });
    });

    it("omits unset fields and reports gh's stderr on failure", () => {
      const rejected = deriveGhFixture(update, {
        exitCode: 1,
        stdout: "",
        stderr: "HTTP 422: Validation Failed\n",
      });
      const fake = new FakeGitHubProvider(rejected);
      const result = fake.updatePRSync(1563, { base: "main" });
      expect(JSON.parse(fake.calls[0].opts.input ?? "")).toEqual({
        base: "main",
      });
      expect(result).toEqual({
        success: false,
        error: "HTTP 422: Validation Failed",
      });
    });

    it("makes no call when there is nothing to update", () => {
      const fake = new FakeGitHubProvider();
      expect(fake.updatePRSync(1563, {})).toEqual({ success: true });
      expect(fake.calls).toHaveLength(0);
    });
  });

  // #605: async createPR(opts) must forward opts.base to the underlying
  // `gh pr create` call. Previously dropped silently.
  describe("createPR (async) forwards opts.base", () => {
    it("passes --base <opts.base> to gh pr create", async () => {
      const fake = new FakeGitHubProvider(loadGhFixture("pr-create"));
      const result = await fake.createPR({
        title: "feat(#605): test",
        body: "body",
        head: "feature/605",
        base: "feature/predecessor",
      });

      expect(result).toEqual({
        number: 1563,
        url: "https://github.com/sequant-io/sequant/pull/1563",
      });
      expect(fake.calls[0]).toEqual({
        args: [
          "pr",
          "create",
          "--title",
          "feat(#605): test",
          "--body",
          "body",
          "--head",
          "feature/605",
          "--base",
          "feature/predecessor",
        ],
        opts: { timeout: 30000, cwd: undefined },
      });
    });
  });

  describe("listOpenPRFilesSync (#1454)", () => {
    const prList = loadGhFixture("pr-list-open-files");

    it("parses gh pr list into number, head and file paths", () => {
      const raw = JSON.parse(prList.stdout) as Array<{
        number: number;
        headRefName: string;
        files: Array<{ path: string }>;
      }>;
      expect(raw.length).toBeGreaterThan(0);
      expect(new FakeGitHubProvider(prList).listOpenPRFilesSync()).toEqual(
        raw.map((pr) => ({
          number: pr.number,
          headRefName: pr.headRefName,
          files: pr.files.map((f) => f.path),
        })),
      );
    });

    it("throws instead of returning [] when gh fails", () => {
      const loggedOut = loadGhFixture("auth-status-logged-out");
      const fake = new FakeGitHubProvider(
        deriveGhFixture(prList, {
          exitCode: 1,
          stdout: "",
          stderr: loggedOut.stderr,
        }),
      );
      expect(() => fake.listOpenPRFilesSync()).toThrow(
        /gh pr list failed .*gh auth login/,
      );
    });

    it("throws on output that is not JSON", () => {
      const fake = new FakeGitHubProvider(
        deriveGhFixture(prList, { stdout: "not json" }),
      );
      expect(() => fake.listOpenPRFilesSync()).toThrow(/not JSON/);
    });
  });
});
