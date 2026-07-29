/**
 * Integration tests for --phases CLI validation against the phase registry.
 *
 * AC-6: `--phases foo,exec` must exit non-zero with a clear error message
 * naming the unknown phase and listing available phases.
 *
 * Spawns the prebuilt `dist/bin/cli.js` rather than `tsx bin/cli.ts` (#842).
 * `--phases` validation is Commander argument coercion — byte-identical in
 * source and compiled form — so `tsx` bought nothing here but a full
 * TypeScript compile per spawn: 4.2 s idle on a cold cache, 7.5-17.8 s under
 * full-suite load, against a 5 s vitest budget. `vitest.global-setup.ts`
 * builds once precisely so integration tests can use `dist` instead.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");
const cliPath = resolve(projectRoot, "dist/bin/cli.js");

// Build handled by vitest globalSetup (vitest.global-setup.ts). Fail loudly if
// it is missing rather than `describe.skipIf(!distExists)` — a skip would make
// this validation gate silently vanish for anyone running vitest without a
// build, which is exactly the failure mode #842 AC-6 guards against.
beforeAll(() => {
  if (!existsSync(cliPath)) {
    throw new Error(
      `dist/bin/cli.js not found at ${cliPath}. Run 'npm run build' first.`,
    );
  }
});

function runCli(args: string[]) {
  return spawnSync("node", [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    // Disable home-stray warnings + node_modules warnings noise
    env: { ...process.env, NO_COLOR: "1" },
  });
}

describe("--phases registry validation (AC-6)", () => {
  it("exits non-zero when given an unknown phase", () => {
    const result = runCli(["run", "1", "--phases", "deploy", "--dry-run"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown phase 'deploy'");
    expect(result.stderr).toContain("Available:");
    // Must list known phases in the error so users can spot the typo
    expect(result.stderr).toContain("spec");
    expect(result.stderr).toContain("exec");
    expect(result.stderr).toContain("qa");
  });

  it("rejects unknown phase even when mixed with valid phases", () => {
    const result = runCli([
      "run",
      "1",
      "--phases",
      "exec,deploy,qa",
      "--dry-run",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown phase 'deploy'");
  });

  it("accepts a list of valid registered phases", () => {
    // Smoke: --phases spec,exec,qa must not trip the validator. The command
    // may still exit non-zero for downstream reasons (no GH issue, etc.) but
    // it must NOT exit with the "Unknown phase" message.
    //
    // No `spawnSync` `timeout:` here. The one this replaced was 30 s against
    // vitest's 5 s default, so vitest always killed the test first and the
    // child timeout could never fire (#842 AC-3). Nothing here needs a child
    // timeout: `--dry-run` short-circuits before any network or worktree work,
    // so the whole invocation is sub-second, and the project-level
    // `testTimeout` in vitest.config.ts is the backstop.
    const result = runCli([
      "run",
      "999999999",
      "--phases",
      "spec,exec,qa",
      "--dry-run",
    ]);

    expect(result.stderr).not.toContain("Unknown phase");
  });
});
