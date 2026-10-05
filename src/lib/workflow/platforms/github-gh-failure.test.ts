import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "child_process";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { GitHubProvider } from "./github.js";
import { postQaVerdictComment } from "../batch-executor.js";

const mockSpawn = vi.mocked(spawnSync);

const FAILURES = {
  "non-zero exit": { status: 1, stderr: "HTTP 502: bad gateway" },
  timeout: {
    status: null,
    signal: "SIGTERM",
    stderr: "",
    error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
  },
  "spawn failure": {
    status: null,
    stderr: "",
    error: Object.assign(new Error("spawnSync gh ENOENT"), {
      code: "ENOENT",
    }),
  },
};

describe("GitHubProvider gh failures (#1312)", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  const calls: Array<[string, (p: GitHubProvider) => Promise<unknown>]> = [
    ["postComment", (p) => p.postComment("1", "body")],
    ["addLabel", (p) => p.addLabel("1", "bug")],
    ["removeLabel", (p) => p.removeLabel("1", "bug")],
    ["postPRComment", (p) => p.postPRComment("7", "body")],
    ["getIssueComments", (p) => p.getIssueComments("1")],
  ];

  for (const [name, call] of calls) {
    for (const [label, result] of Object.entries(FAILURES)) {
      it(`${name} rejects on ${label}`, async () => {
        mockSpawn.mockReturnValue(result as never);
        await expect(call(new GitHubProvider())).rejects.toThrow(
          /gh .* failed/,
        );
      });
    }

    it(`${name} carries gh's stderr`, async () => {
      mockSpawn.mockReturnValue(FAILURES["non-zero exit"] as never);
      await expect(call(new GitHubProvider())).rejects.toThrow(
        "HTTP 502: bad gateway",
      );
    });

    it(`${name} resolves on exit 0`, async () => {
      mockSpawn.mockReturnValue({
        status: 0,
        stderr: "",
        stdout: "[]",
      } as never);
      await expect(call(new GitHubProvider())).resolves.toEqual(
        name === "getIssueComments" ? [] : undefined,
      );
    });
  }

  it("postQaVerdictComment logs the warning with stderr via the real provider", async () => {
    mockSpawn.mockReturnValue(FAILURES["non-zero exit"] as never);
    const log = vi.fn();
    await postQaVerdictComment(
      1312,
      "AC_NOT_MET" as never,
      undefined,
      undefined,
      1,
      log,
    );
    expect(mockSpawn).toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const msg = String(log.mock.calls[0][0]);
    expect(msg).toContain("Failed to post QA verdict comment");
    expect(msg).toContain("HTTP 502: bad gateway");
  });
});
