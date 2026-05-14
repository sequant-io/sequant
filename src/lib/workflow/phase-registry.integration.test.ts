/**
 * Integration tests for --phases CLI validation against the phase registry.
 *
 * AC-6: `--phases foo,exec` must exit non-zero with a clear error message
 * naming the unknown phase and listing available phases.
 */

import { spawnSync } from "child_process";
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");
const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");
const cliSource = resolve(projectRoot, "bin/cli.ts");

describe("--phases registry validation (AC-6)", () => {
  it("exits non-zero when given an unknown phase", () => {
    const result = spawnSync(
      tsxBin,
      [cliSource, "run", "1", "--phases", "deploy", "--dry-run"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        // Disable home-stray warnings + node_modules warnings noise
        env: { ...process.env, NO_COLOR: "1" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown phase 'deploy'");
    expect(result.stderr).toContain("Available:");
    // Must list known phases in the error so users can spot the typo
    expect(result.stderr).toContain("spec");
    expect(result.stderr).toContain("exec");
    expect(result.stderr).toContain("qa");
  });

  it("rejects unknown phase even when mixed with valid phases", () => {
    const result = spawnSync(
      tsxBin,
      [cliSource, "run", "1", "--phases", "exec,deploy,qa", "--dry-run"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown phase 'deploy'");
  });

  it("accepts a list of valid registered phases", () => {
    // Smoke: --phases spec,exec,qa must not trip the validator. The command
    // may still exit non-zero for downstream reasons (no GH issue, etc.) but
    // it must NOT exit with the "Unknown phase" message.
    const result = spawnSync(
      tsxBin,
      [cliSource, "run", "999999999", "--phases", "spec,exec,qa", "--dry-run"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
        // Short timeout — we only care that the *validator* doesn't reject.
        timeout: 30000,
      },
    );

    expect(result.stderr).not.toContain("Unknown phase");
  });
});
