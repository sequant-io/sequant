/**
 * Spec citation grounding CLI — integration tests (shell out to the real CLI).
 *
 * Split from `ground-check.test.ts` for the #842 reason: a file without the
 * `.integration.` infix runs in the `unit` project — 5 s testTimeout,
 * `fileParallelism` ON — while these tests spawn `npx tsx`, which idles around
 * 4 s cold and much longer under load. The `.integration.` name puts them
 * where subprocess spawns are serialized and the 30 s project floor applies.
 * The 90 s describe ceiling sits strictly above the per-child timeout so the
 * child kill reports SIGTERM with captured output instead of vitest's opaque
 * timeout.
 *
 * These cover the contract AC-1 states and the unit tests cannot: real argv,
 * real stdin, real `git` against this repository, and the "always exit 0"
 * guarantee that lets `/spec` call the checker without a gating wrapper.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "ground-check.ts");
const REPO_ROOT = path.resolve(__dirname, "../..");

function runCli(
  args: string[],
  input?: string,
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI_PATH, ...args], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      timeout: 60_000,
      input: input ?? "",
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", status: err.status ?? 1 };
  }
}

describe("ground-check CLI (integration)", { timeout: 90_000 }, () => {
  it("--help prints usage and exits 0", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Spec Citation Grounding Check");
    expect(stdout).toContain("--ref");
    expect(stdout).toContain("--out");
  });

  it("reads stdin and resolves real repository paths", () => {
    const input =
      "The deterministic precheck lives in `scripts/qa/precheck.ts`, and the " +
      "CLI entry point is `bin/cli.ts`.";
    const { stdout, status } = runCli([], input);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.schemaVersion).toBe(1);
    const raws = result.citations.map((c: { raw: string }) => c.raw);
    expect(raws).toContain("scripts/qa/precheck.ts");
    expect(raws).toContain("bin/cli.ts");
    expect(result.citations.every((c: { exists: boolean }) => c.exists)).toBe(
      true,
    );
  });

  it("flags a nonexistent path without failing the run", () => {
    const { stdout, status } = runCli(
      [],
      "The logic lives in `src/lib/definitely-not-a-real-file.ts`.",
    );
    // Always exit 0: findings live in the JSON, consumers decide gating.
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.summary.missingReferenced).toBe(1);
    expect(result.citations[0].exists).toBe(false);
  });

  it("--in reads a file and --out writes the JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ground-check-"));
    const inPath = path.join(tmpDir, "plan.md");
    const outPath = path.join(tmpDir, "out.json");
    fs.writeFileSync(inPath, "See `bin/cli.ts` for the flag registration.");

    const { status } = runCli(["--in", inPath, "--out", outPath]);
    expect(status).toBe(0);

    const written = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    expect(written.schemaVersion).toBe(1);
    expect(written.summary.resolved).toBe(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--ref checks against a historical commit", () => {
    // `scripts/spec/ground-check.ts` is introduced by this branch, so at the
    // base commit it must not resolve. This is the mechanism the corpus
    // measurement relies on to tell planned-new apart from phantom.
    const base = execFileSync("git", ["rev-parse", "origin/main"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
    }).trim();

    const { stdout, status } = runCli(
      ["--ref", base],
      "The checker lives in `scripts/spec/ground-check.ts`.",
    );
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.ref).toBe(base);
    expect(result.citations[0].exists).toBe(false);
  });

  it("an unresolvable ref degrades to empty rather than crashing", () => {
    const { stdout, status } = runCli(
      ["--ref", "not-a-real-ref-0000"],
      "See `bin/cli.ts`.",
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout).citations[0].exists).toBe(false);
  });
});
