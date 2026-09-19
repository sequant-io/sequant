/**
 * Integration test for GitHubProvider.checkAuthSync()'s wall-clock bound (#1099).
 *
 * `checkAuthSync()` shells out to `gh auth status`, which reaches the
 * network — a stalled request or a hung `gh` used to hang every caller
 * (`doctor`, upstream assessment) with no output and no way out but Ctrl-C.
 *
 * The case puts a stub at the front of `PATH` that sleeps far longer than
 * the probe's bound, then asserts both the fallback return value *and* the
 * elapsed wall time. The wall-time assertion is the real gate: a stub that
 * exits immediately would already return `false` even with the timeout
 * removed, so the return value alone would pass a mutated (un-timed) probe.
 *
 * Lives in the integration project deliberately — the `unit` project keeps
 * vitest's 5s default (#842), which a timeout test would blow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { GitHubProvider } from "./github.js";

describe.skipIf(process.platform === "win32")(
  "GitHubProvider.checkAuthSync timeout (#1099)",
  { timeout: 45_000 },
  () => {
    /** Far longer than the 10s probe bound, but still bounded: `execSync`
     * is synchronous and vitest cannot interrupt it, so an unbounded sleep
     * would hang the run instead of failing it when the timeout is removed. */
    const STUB_SLEEP_SECONDS = 25;

    let stubDir: string;

    beforeEach(() => {
      stubDir = mkdtempSync(join(tmpdir(), "sequant-1099-stub-"));
      const path = join(stubDir, "gh");
      // `exec` so the direct child IS sleep: a forked grandchild would
      // outlive the SIGTERM and hold the stdio open past the timeout.
      writeFileSync(path, `#!/bin/sh\nexec sleep ${STUB_SLEEP_SECONDS}\n`);
      chmodSync(path, 0o755);
    });

    afterEach(() => {
      rmSync(stubDir, { recursive: true, force: true });
    });

    it("1099: a hanging gh makes checkAuthSync() return false within the timeout, not hang", () => {
      const prevPath = process.env.PATH;
      process.env.PATH = `${stubDir}:${prevPath ?? ""}`;

      try {
        const provider = new GitHubProvider();
        const started = Date.now();
        const authenticated = provider.checkAuthSync();
        const elapsedMs = Date.now() - started;

        expect(authenticated).toBe(false);
        // 1.5x the 10s probe bound — generous for CI, far under the 25s stub.
        expect(elapsedMs).toBeLessThan(15_000);
      } finally {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
      }
    });
  },
);
