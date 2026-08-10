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
    // Working-tree mode still pins the SHA it ran against (HEAD), so a later
    // consumer can detect that the tree moved since the check.
    expect(result.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
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

  it("--ref checks against a historical commit, not the working tree", () => {
    // Builds its own two-commit repository rather than reaching for
    // `origin/main`. The first version of this test did the latter and passed
    // locally but failed in CI, where `actions/checkout` leaves no
    // `origin/main` ref to resolve — a dependency on ambient repo state, not
    // on the behavior under test.
    //
    // This is the mechanism `measure-corpus.ts` relies on to tell planned-new
    // apart from phantom, so it has to hold precisely: a file present in the
    // working tree but absent at the ref must resolve as absent.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ground-check-hist-"));
    try {
      const git = (...args: string[]): string =>
        execFileSync(
          "git",
          [
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=test",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: repo, encoding: "utf-8" },
        );

      git("init", "-q");
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      fs.writeFileSync(path.join(repo, "src", "old.ts"), "export const a = 1;");
      git("add", "-A");
      git("commit", "-q", "-m", "first");
      const base = git("rev-parse", "HEAD").trim();

      // Second commit introduces a file the first commit never had.
      fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const b = 2;");
      git("add", "-A");
      git("commit", "-q", "-m", "second");

      const input = "Both `src/old.ts` and `src/new.ts` are referenced here.";

      const atBase = execFileSync("npx", ["tsx", CLI_PATH, "--ref", base], {
        encoding: "utf-8",
        cwd: repo,
        timeout: 60_000,
        input,
      });
      const baseResult = JSON.parse(atBase);
      expect(baseResult.ref).toBe(base);
      expect(baseResult.resolvedSha).toBe(base);
      const byRaw = (r: {
        citations: Array<{ raw: string; exists: boolean }>;
      }) => Object.fromEntries(r.citations.map((c) => [c.raw, c.exists]));
      expect(byRaw(baseResult)).toEqual({
        "src/old.ts": true,
        "src/new.ts": false,
      });

      // Same input against the working tree resolves both — proving the
      // difference came from the ref and not from extraction.
      const atHead = execFileSync("npx", ["tsx", CLI_PATH], {
        encoding: "utf-8",
        cwd: repo,
        timeout: 60_000,
        input,
      });
      const headResult = JSON.parse(atHead);
      expect(byRaw(headResult)).toEqual({
        "src/old.ts": true,
        "src/new.ts": true,
      });
      // Working-tree mode pins HEAD — here the second commit, not the base.
      const head = git("rev-parse", "HEAD").trim();
      expect(headResult.resolvedSha).toBe(head);
      expect(head).not.toBe(base);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an unresolvable ref degrades to empty rather than crashing", () => {
    const { stdout, status } = runCli(
      ["--ref", "not-a-real-ref-0000"],
      "See `bin/cli.ts`.",
    );
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.citations[0].exists).toBe(false);
    // An unresolvable ref cannot be pinned; null says so rather than
    // silently reporting HEAD as if it were the requested ref.
    expect(result.resolvedSha).toBeNull();
  });
});
