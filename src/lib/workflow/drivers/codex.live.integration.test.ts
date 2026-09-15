/**
 * Live codex smoke test (#497 AC-7).
 *
 * Mirrors opencode.live.integration.test.ts's skip-gate shape exactly (per
 * AC-7's own stated assumption). Runs a single trivial prompt against a real
 * `codex` binary, and only when both the binary and credentials are present.
 * When either is missing it reports `SKIPPED (codex absent)` — never a bare
 * pass, per AC-7's explicit wording.
 *
 * Run it deliberately:
 *   CODEX_LIVE=1 npx vitest run \
 *     src/lib/workflow/drivers/codex.live.integration.test.ts
 *
 * ASSUMPTION: credential eligibility is `CODEX_API_KEY` set OR `codex login
 * status` reporting logged in (AC-7's own wording). `codexLoggedIn()` below
 * shells out to `codex login status`; if the real CLI's subcommand or exit
 * code differs, update that helper — the gate's SKIPPED-vs-eligible contract
 * is what AC-7 actually requires, not this exact probe.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CodexDriver, CodexStreamParser } from "./codex.js";

function binaryPresent(): boolean {
  try {
    execFileSync("which", ["codex"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function codexLoggedIn(): boolean {
  if ((process.env.CODEX_API_KEY ?? "").length > 0) return true;
  try {
    const out = execFileSync("codex", ["login", "status"], {
      stdio: "pipe",
    }).toString();
    return /logged in/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Why the live run is not eligible, or undefined when it is.
 *
 * Opt-in is deliberate: this spawns a real, billable agent.
 */
function skipReason(): string | undefined {
  if (process.env.CODEX_LIVE !== "1") {
    return "SKIPPED (codex live run not opted in — set CODEX_LIVE=1)";
  }
  if (!binaryPresent()) return "SKIPPED (codex absent)";
  if (!codexLoggedIn()) {
    return "SKIPPED (codex absent: no CODEX_API_KEY and not logged in)";
  }
  return undefined;
}

/**
 * Resolved once at load, so vitest's own summary reports these as SKIPPED —
 * an early `return` inside the test body would report a pass instead, which
 * is exactly what AC-7 forbids.
 */
const SKIP = skipReason();

if (SKIP) {
  // eslint-disable-next-line no-console
  console.log(`  497 AC-7 live codex smoke: ${SKIP}`);
}

describe("497 AC-7: codex live smoke", () => {
  it("497 AC-7 gates the live run on a SKIPPED reason, never on a bare pass", () => {
    if (SKIP) {
      expect(SKIP).toContain("SKIPPED");
      return;
    }
    expect(binaryPresent() && codexLoggedIn()).toBe(true);
  });

  it.skipIf(SKIP)(
    "497 AC-7 spawns a real run and receives at least one agent_message",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "sequant-codex-live-"));
      // `codex exec` refuses a cwd that is not inside a git repository
      // ("Not inside a trusted directory and --skip-git-repo-check was not
      // specified", exit 1, zero events). Sequant only ever hands the driver
      // a worktree, so the driver does not pass `--skip-git-repo-check`;
      // this test must therefore give it a git repo too.
      execFileSync("git", ["init", "-q", workDir], { stdio: "pipe" });
      try {
        const driver = new CodexDriver();
        const rawChunks: string[] = [];
        const result = await driver.executePhase(
          "Reply with exactly the word: pong. Do not use any tools.",
          {
            cwd: workDir,
            env: {},
            phaseTimeout: 180,
            verbose: true,
            onOutput: (chunk) => rawChunks.push(chunk),
            mcp: false,
          },
        );

        expect(
          result.output.length,
          `no agent_message text; driver error: ${result.error ?? "(none)"}`,
        ).toBeGreaterThan(0);
        expect(result.resumeHandle?.driver).toBe("codex");
        expect(result.resumeHandle?.originCwd).toBe(workDir);

        // The same raw stream, re-parsed from scratch, must agree with what
        // the driver extracted — a real-stream check, not a synthetic line.
        const reparsed = new CodexStreamParser();
        for (const chunk of rawChunks) reparsed.feed(chunk);
        const stream = reparsed.end();
        expect(stream.output).toBe(result.output);
        expect(stream.threadId).toBe(result.resumeHandle?.token);
        expect(stream.sawTurnCompleted).toBe(true);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    200_000,
  );
});
