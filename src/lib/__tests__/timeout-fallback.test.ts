/**
 * The portable timeout fallback the skills and the hook message recommend
 * (#1054): `perl -e 'alarm shift; exec @ARGV' <secs> <cmd…>`. `alarm`
 * survives `exec`, so the exec'd command receives SIGALRM at the deadline.
 * Behavioural, not textual: a 5-second sleep under a 1-second alarm must die
 * early. Guards the documented form against a well-meaning "simplification".
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

describe("portable timeout fallback (#1054)", () => {
  it("kills the command at the alarm deadline", () => {
    const started = Date.now();
    const result = spawnSync(
      "perl",
      ["-e", "alarm shift; exec @ARGV", "1", "sleep", "5"],
      { encoding: "utf-8" },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);
    // Killed by SIGALRM: non-zero status or a signal, never a clean exit.
    expect(result.status === 0 && result.signal === null).toBe(false);
  });

  it("passes a fast command through unchanged", () => {
    const result = spawnSync(
      "perl",
      ["-e", "alarm shift; exec @ARGV", "5", "true"],
      { encoding: "utf-8" },
    );
    expect(result.status).toBe(0);
  });
});
