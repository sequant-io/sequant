import { describe, it, expect } from "vitest";

import { FakeGitHubProvider } from "./fake-github.js";
import { GhCommandError } from "./github.js";
import {
  GhFixtureMissingError,
  deriveGhFixture,
  loadGhFixture,
} from "./gh-fixtures.js";

// #1506: the fake is the real GitHubProvider over a runner that replays
// captured gh output, so each case below runs the production parsing.

describe("FakeGitHubProvider: every PlatformProvider method from a fixture", () => {
  it("fetchIssue", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("issue-view"));
    const issue = await fake.fetchIssue("1475");
    expect(issue).toMatchObject({ id: "1475", number: 1475, state: "closed" });
    expect(issue.labels).toContain("refactor");
    expect(issue.title).toMatch(/worktreeStatus/);
  });

  it("postComment", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("issue-comment"));
    await expect(fake.postComment("1475", "hello")).resolves.toBeUndefined();
    expect(fake.calls[0].args).toEqual([
      "issue",
      "comment",
      "1475",
      "--body",
      "hello",
    ]);
  });

  it("addLabel", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("issue-edit-add-label"));
    await expect(fake.addLabel("1475", "bug")).resolves.toBeUndefined();
  });

  it("removeLabel", async () => {
    const fake = new FakeGitHubProvider(
      loadGhFixture("issue-edit-remove-label"),
    );
    await expect(fake.removeLabel("1475", "bug")).resolves.toBeUndefined();
  });

  it("createPR", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("pr-create"));
    await expect(
      fake.createPR({ title: "t", body: "b", head: "feature/x", base: "main" }),
    ).resolves.toEqual({
      number: 1563,
      url: "https://github.com/sequant-io/sequant/pull/1563",
    });
  });

  it("getPRStatus", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("pr-view-state"));
    await expect(fake.getPRStatus("1563")).resolves.toEqual({
      state: "merged",
    });
  });

  it("postPRComment", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("pr-comment"));
    await expect(fake.postPRComment("1563", "report")).resolves.toBeUndefined();
  });

  it("checkAuth", async () => {
    await expect(
      new FakeGitHubProvider(loadGhFixture("auth-status")).checkAuth(),
    ).resolves.toBe(true);
    await expect(
      new FakeGitHubProvider(
        loadGhFixture("auth-status-logged-out"),
      ).checkAuth(),
    ).resolves.toBe(false);
  });

  it("getIssueComments", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("issue-comments"));
    const comments = await fake.getIssueComments("1475");
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]).toEqual({
      body: expect.any(String),
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
  });
});

describe("FakeGitHubProvider: gh failures surface as GhCommandError", () => {
  it("an exitCode: 1 fixture throws the provider's error class with gh's stderr", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("issue-view-not-found"));
    const err = await fake.fetchIssue("999999").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhCommandError);
    expect((err as GhCommandError).exitCode).toBe(1);
    expect((err as GhCommandError).stderr).toMatch(
      /Could not resolve to an issue or pull request/,
    );
  });

  it.each([
    ["pr-comment-http-502", /exit 1\): HTTP 502/],
    ["pr-comment-timeout", /ETIMEDOUT/],
    ["pr-comment-gh-missing", /ENOENT/],
  ])("%s rejects with GhCommandError", async (name, message) => {
    const fake = new FakeGitHubProvider(loadGhFixture(name));
    const err = await fake.postPRComment("1563", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhCommandError);
    expect(String((err as Error).message)).toMatch(message);
  });

  it("an unknown command throws GhFixtureMissingError naming the capture script", async () => {
    const fake = new FakeGitHubProvider(loadGhFixture("issue-view"));
    const err = await fake.postComment("1", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhFixtureMissingError);
    expect(String((err as Error).message)).toContain(
      "scripts/capture-gh-fixtures.ts",
    );
  });
});

describe("deriveGhFixture", () => {
  it("keeps the captured shape and records where it came from", () => {
    const base = loadGhFixture("issue-view");
    const open = deriveGhFixture(base, {
      args: ["issue", "view", "42", "--json", "number,title,body,labels,state"],
      json: (d) => ({ ...(d as object), number: 42, state: "OPEN" }),
    });
    expect(open).toMatchObject({
      provenance: "derived",
      derivedFrom: "issue-view",
    });
    expect(new FakeGitHubProvider(open).fetchIssueSync("42")).toMatchObject({
      number: 42,
      state: "open",
      labels: expect.arrayContaining(["refactor"]),
    });
  });
});
