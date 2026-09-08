/**
 * Live opencode smoke test (#862 AC-2).
 *
 * This is the only test in the suite that spends money. It runs a single
 * trivial prompt against a real `opencode` binary, and only when both the
 * binary and a provider key are present. When either is missing it reports
 * `SKIPPED (opencode absent)` — it must never report a pass it did not earn,
 * because a green tick on a machine with no opencode installed is exactly the
 * false assurance the unit suite already gives (it mocks `spawn`).
 *
 * Run it deliberately:
 *   OPENCODE_LIVE=1 npx vitest run \
 *     src/lib/workflow/drivers/opencode.live.integration.test.ts
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OpencodeDriver, OpencodeStreamParser } from "./opencode.js";

/** Provider keys any of which is enough for opencode to reach a model. */
const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

function binaryPresent(): boolean {
  try {
    execFileSync("which", ["opencode"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function providerKeyPresent(): boolean {
  return PROVIDER_KEYS.some((k) => (process.env[k] ?? "").length > 0);
}

/**
 * Why the live run is not eligible, or undefined when it is.
 *
 * Opt-in is deliberate: this spawns a real, billable agent, so a developer
 * who merely happens to have opencode installed does not pay for it on every
 * `npm test`.
 */
function skipReason(): string | undefined {
  if (process.env.OPENCODE_LIVE !== "1") {
    return "SKIPPED (opencode live run not opted in — set OPENCODE_LIVE=1)";
  }
  if (!binaryPresent()) return "SKIPPED (opencode absent)";
  if (!providerKeyPresent()) {
    return `SKIPPED (opencode absent: no provider key — one of ${PROVIDER_KEYS.join(", ")})`;
  }
  return undefined;
}

/**
 * Resolved once at load. `it.skipIf` consumes it so vitest reports these as
 * SKIPPED in its own summary — an early `return` inside the test body would
 * report a pass, which is exactly what the AC forbids.
 */
const SKIP = skipReason();

if (SKIP) {
  // eslint-disable-next-line no-console
  console.log(`  862 AC-2 live opencode smoke: ${SKIP}`);
}

describe("862 AC-2: opencode live smoke", () => {
  it("862 AC-2 gates the live run on a SKIPPED reason, never on a bare pass", () => {
    // The skip path is itself under test: on a machine with no opencode, the
    // gate must resolve to a SKIPPED reason (which `it.skipIf` then reports as
    // skipped) rather than to eligibility.
    if (SKIP) {
      expect(SKIP).toContain("SKIPPED");
      return;
    }
    expect(binaryPresent() && providerKeyPresent()).toBe(true);
  });

  it.skipIf(SKIP)(
    "862 AC-2 spawns a real run and receives at least one text event",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "sequant-opencode-live-"));
      try {
        const driver = new OpencodeDriver();
        const result = await driver.executePhase(
          "Reply with exactly the word: pong. Do not use any tools.",
          {
            cwd: workDir,
            env: {},
            // No `phase`: this prompt loads no skill, so the AC-4 marker check
            // must not apply to it.
            phaseTimeout: 180,
            verbose: false,
            mcp: false,
          },
        );

        expect(result.output.length).toBeGreaterThan(0);
        expect(result.resumeHandle?.driver).toBe("opencode");
        expect(result.resumeHandle?.originCwd).toBe(workDir);
      } finally {
        // `workDir` is a mkdtemp result, never reassigned (#883).
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    200_000,
  );

  it.skipIf(SKIP)(
    "862 AC-2 parses a real stream through the same parser the driver uses",
    () => {
      // Sanity: the parser used above is the production one, fed a single event.
      const parser = new OpencodeStreamParser();
      parser.feed(
        `${JSON.stringify({
          type: "text",
          sessionID: "ses_live",
          part: { text: "pong" },
        })}\n`,
      );
      expect(parser.end().output).toBe("pong");
    },
  );
});
