/**
 * Golden-corpus snapshot for `pre-tool.sh` (#1094).
 *
 * Every command in `__tests__/fixtures/hook-corpus.jsonl` is replayed through
 * all three hook copies and must produce the exit code and block reason the
 * snapshot records. A change that flips any verdict fails here until the
 * snapshot is updated in the same PR, so the flip is visible in review.
 *
 * Update the snapshot deliberately: run
 * `npx tsx scripts/hook-corpus.ts --diff origin/main`, list each changed
 * verdict in the PR body under `Hook verdicts changed:`, then edit the affected
 * corpus lines.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  REPO_ROOT,
  createReplayEnv,
  loadCorpus,
  replayCase,
  type ReplayEnv,
} from "../scripts/hook-corpus.ts";

const HOOK_COPIES: Array<[label: string, path: string]> = [
  [
    "templates/hooks/pre-tool.sh",
    join(REPO_ROOT, "templates", "hooks", "pre-tool.sh"),
  ],
  ["hooks/pre-tool.sh", join(REPO_ROOT, "hooks", "pre-tool.sh")],
  [
    ".claude/hooks/pre-tool.sh",
    join(REPO_ROOT, ".claude", "hooks", "pre-tool.sh"),
  ],
];

const corpus = loadCorpus();

describe("hook corpus fixture", () => {
  it("is non-empty and free of duplicate commands", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(150);
    const keys = corpus.map((c) => `${c.state}\u0000${c.command}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe.each(HOOK_COPIES)("hook corpus replay [%s]", (_label, hookPath) => {
  let env: ReplayEnv;

  beforeAll(() => {
    env = createReplayEnv();
  });

  afterAll(() => {
    env.cleanup();
  });

  it.each(
    corpus.map(
      (c, i) =>
        [
          `${c.source} #${i} ${c.command.replace(/\s+/g, " ").slice(0, 70)}`,
          c,
        ] as const,
    ),
  )("%s", (_title, c) => {
    const verdict = replayCase(hookPath, c, env);
    expect({ exit: verdict.exit, block: verdict.block }).toEqual({
      exit: c.exit,
      block: c.block,
    });
  });
});
