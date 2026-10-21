import { describe, it, expect, vi } from "vitest";

import { GhCommandError, type GitHubProvider } from "./github.js";
import { FakeGitHubProvider } from "./fake-github.js";
import { deriveGhFixture, loadGhFixture, ANY_ARG } from "./gh-fixtures.js";
import { postQaVerdictComment } from "../batch-executor.js";

// #1312: each of the three ways a gh call fails, as a fixture (#1506).
const FAILURES = {
  "non-zero exit": loadGhFixture("pr-comment-http-502"),
  timeout: loadGhFixture("pr-comment-timeout"),
  "spawn failure": loadGhFixture("pr-comment-gh-missing"),
};
const STDERR = FAILURES["non-zero exit"].stderr.trim();

const calls: Array<
  [string, string[], (p: GitHubProvider) => Promise<unknown>]
> = [
  [
    "postComment",
    ["issue", "comment", "1", "--body", ANY_ARG],
    (p) => p.postComment("1", "body"),
  ],
  [
    "addLabel",
    ["issue", "edit", "1", "--add-label", ANY_ARG],
    (p) => p.addLabel("1", "bug"),
  ],
  [
    "removeLabel",
    ["issue", "edit", "1", "--remove-label", ANY_ARG],
    (p) => p.removeLabel("1", "bug"),
  ],
  [
    "postPRComment",
    ["pr", "comment", "7", "--body", ANY_ARG],
    (p) => p.postPRComment("7", "body"),
  ],
  [
    "getIssueComments",
    loadGhFixture("issue-comments").args.map((a) => (a === "1475" ? "1" : a)),
    (p) => p.getIssueComments("1"),
  ],
];

describe("GitHubProvider gh failures (#1312)", () => {
  for (const [name, args, call] of calls) {
    for (const [label, failure] of Object.entries(FAILURES)) {
      it(`${name} rejects on ${label}`, async () => {
        const fake = new FakeGitHubProvider(deriveGhFixture(failure, { args }));
        const err = await call(fake).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(GhCommandError);
        expect(String((err as Error).message)).toMatch(/gh .* failed/);
      });
    }

    it(`${name} carries gh's stderr`, async () => {
      const fake = new FakeGitHubProvider(
        deriveGhFixture(FAILURES["non-zero exit"], { args }),
      );
      await expect(call(fake)).rejects.toThrow(STDERR);
    });

    it(`${name} resolves on exit 0`, async () => {
      const ok = deriveGhFixture(loadGhFixture("issue-comment"), {
        args,
        stdout: "[]",
      });
      await expect(call(new FakeGitHubProvider(ok))).resolves.toEqual(
        name === "getIssueComments" ? [] : undefined,
      );
    });
  }

  it("postQaVerdictComment logs the warning with stderr via the real provider", async () => {
    const fake = new FakeGitHubProvider(
      deriveGhFixture(FAILURES["non-zero exit"], {
        args: ["issue", "comment", "1312", "--body", ANY_ARG],
      }),
    );
    const log = vi.fn();
    await postQaVerdictComment(
      1312,
      "AC_NOT_MET" as never,
      undefined,
      undefined,
      1,
      log,
      (n, body) => fake.postComment(String(n), body),
    );
    expect(fake.calls).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    const msg = String(log.mock.calls[0][0]);
    expect(msg).toContain("Failed to post QA verdict comment");
    expect(msg).toContain(STDERR);
  });
});
