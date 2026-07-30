/**
 * Integration tests for LockManager (#625).
 *
 * Spawn real child processes to exercise the `open(O_CREAT | O_EXCL)`
 * atomicity guarantee under concurrent contention. These complement the
 * mocked unit tests in `lock-manager.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn } from "child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = resolve(__dirname, "lock-manager.ts");
const SHUTDOWN_PATH = resolve(__dirname, "../shutdown.ts");
const TSX_BIN = resolve(__dirname, "../../../node_modules/.bin/tsx");

/**
 * Run a short Node script that acquires a lock and exits. Returns the
 * child's stdout JSON describing whether acquisition succeeded.
 */
function runAcquireSync(
  dir: string,
  issue: number,
  command: string,
): { acquired: boolean; pid?: number } {
  const script = `
    import { LockManager } from ${JSON.stringify(MODULE_PATH)};
    const mgr = new LockManager({ locksDir: ${JSON.stringify(dir)} });
    const result = mgr.acquire(${issue}, ${JSON.stringify(command)});
    process.stdout.write(JSON.stringify({ acquired: result.acquired, pid: process.pid }));
    // Hold for 200ms so a concurrent acquirer can race.
    setTimeout(() => {}, 200);
  `;
  const result = spawnSync(TSX_BIN, ["--eval", script], {
    encoding: "utf-8",
    env: { ...process.env, SEQUANT_ORCHESTRATOR: "" },
  });
  if (result.status !== 0) {
    throw new Error(
      `tsx failed (status=${result.status}, signal=${result.signal ?? "none"}, error=${result.error?.message ?? "none"}): ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

describe("LockManager — integration: two-process contention", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sequant-locks-int-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "second concurrent process is blocked when the first holds the lock",
    { timeout: 20_000 },
    async () => {
      // Spawn process A — acquires and holds until this test closes its stdin.
      //
      // #856: A used to release on a fixed 1s timer, which races process B's
      // `tsx` boot. Whenever the transform cache is cold — i.e. right after
      // any edit to this module, exactly when the test matters most — B took
      // longer than 1s to start, A had already released, and B then acquired
      // a genuinely free lock. The failure reads as "contention is broken"
      // but is really the harness measuring an empty window. Holding until
      // stdin closes removes the window rather than widening it: A cannot
      // release before B has had its turn.
      const script = `
        import { LockManager } from ${JSON.stringify(MODULE_PATH)};
        const mgr = new LockManager({ locksDir: ${JSON.stringify(dir)} });
        const r = mgr.acquire(42, "first");
        process.stdout.write(JSON.stringify(r) + "\\n");
        process.stdin.on("end", () => { mgr.release(42); process.exit(0); });
        process.stdin.resume();
      `;
      const child = spawn(TSX_BIN, ["--eval", script], {
        env: { ...process.env, SEQUANT_ORCHESTRATOR: "" },
      });
      let stdoutBuf = "";
      child.stdout.on("data", (b) => (stdoutBuf += b.toString()));
      // Wait until process A reports acquisition.
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("A did not report")), 10_000);
        const i = setInterval(() => {
          if (stdoutBuf.includes("acquired")) {
            clearInterval(i);
            clearTimeout(t);
            res();
          }
        }, 50);
      });

      // Process B should be blocked — A is still holding, guaranteed.
      const b = runAcquireSync(dir, 42, "second");
      expect(b.acquired).toBe(false);

      // Now let A release, and wait for it to exit.
      child.stdin.end();
      await new Promise<void>((res) => child.on("exit", () => res()));
      expect(existsSync(join(dir, "42.lock"))).toBe(false);

      // Now a fresh acquirer should succeed.
      const c = runAcquireSync(dir, 42, "third");
      expect(c.acquired).toBe(true);
    },
  );

  it(
    "SIGKILL leaves a stale lock that the next same-host run clears via PID check",
    { timeout: 20_000 },
    async () => {
      const script = `
        import { LockManager } from ${JSON.stringify(MODULE_PATH)};
        const mgr = new LockManager({ locksDir: ${JSON.stringify(dir)} });
        const r = mgr.acquire(42, "victim");
        // Report our actual PID so the parent can SIGKILL the right Node
        // process (the npx wrapper has a different PID than the child).
        process.stdout.write(JSON.stringify({ ...r, pid: process.pid }) + "\\n");
        setTimeout(() => {}, 30_000);
      `;
      const child = spawn(TSX_BIN, ["--eval", script], {
        env: { ...process.env, SEQUANT_ORCHESTRATOR: "" },
      });
      let stdoutBuf = "";
      child.stdout.on("data", (b) => (stdoutBuf += b.toString()));
      await new Promise<void>((res, rej) => {
        const t = setTimeout(
          () => rej(new Error("victim did not report")),
          10_000,
        );
        const i = setInterval(() => {
          if (stdoutBuf.includes("acquired")) {
            clearInterval(i);
            clearTimeout(t);
            res();
          }
        }, 50);
      });

      const reported = JSON.parse(stdoutBuf.trim().split("\n")[0]);
      const victimPid: number = reported.pid;

      // SIGKILL the actual Node process running our script.
      try {
        process.kill(victimPid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await new Promise<void>((res) => child.on("exit", () => res()));

      // Lock should still be on disk with the victim's PID.
      expect(existsSync(join(dir, "42.lock"))).toBe(true);
      const holder = JSON.parse(readFileSync(join(dir, "42.lock"), "utf-8"));
      expect(holder.pid).toBe(victimPid);

      // A new same-host run should auto-clear (PID is dead) and acquire.
      const next = runAcquireSync(dir, 42, "next");
      expect(next.acquired).toBe(true);
    },
  );

  it(
    "an abandoned lock whose PID has been recycled onto a live process is cleared (#856)",
    { timeout: 20_000 },
    async () => {
      // The production shape of related defect 3: `.sequant/locks/505.lock`,
      // written 2026-05-14, PID 28809 long since recycled. The same-host
      // branch of classifyStaleness asked "is that PID alive?", got yes from
      // an unrelated process, and reported the lock fresh — forever.
      //
      // PID 1 stands in for the recycled PID: always alive, never ours, and
      // `process.kill(1, 0)` from a normal user throws EPERM, which
      // `defaultIsPidAlive` correctly reads as alive. So this lock is
      // indistinguishable from a live holder by PID alone — only the age
      // ceiling can free it.
      const thirtyDaysAgo = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
      writeFileSync(
        join(dir, "42.lock"),
        JSON.stringify(
          {
            pid: 1,
            hostname: hostname(),
            startedAt: thirtyDaysAgo,
            command: "npx sequant run 42",
          },
          null,
          2,
        ),
      );

      const next = runAcquireSync(dir, 42, "after-recycle");
      expect(next.acquired).toBe(true);

      // And the lock on disk is now ours, not the abandoned one.
      const holder = JSON.parse(readFileSync(join(dir, "42.lock"), "utf-8"));
      expect(holder.pid).not.toBe(1);
      expect(holder.command).toBe("after-recycle");
    },
  );

  it(
    "a recent lock on a live PID is still respected (age-ceiling negative control)",
    { timeout: 20_000 },
    async () => {
      // Guards the obvious over-correction: the ceiling must not make every
      // same-host lock clearable.
      writeFileSync(
        join(dir, "43.lock"),
        JSON.stringify(
          {
            pid: 1,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
            command: "npx sequant run 43",
          },
          null,
          2,
        ),
      );

      const blocked = runAcquireSync(dir, 43, "should-be-blocked");
      expect(blocked.acquired).toBe(false);
    },
  );

  it(
    "SIGINT triggers ShutdownManager.gracefulShutdown which releases the lock (AC-16)",
    { timeout: 20_000 },
    async () => {
      // Spawn a child that mirrors run-orchestrator.ts:567 — acquires the
      // lock and registers releaseAll() as a ShutdownManager cleanup, then
      // sleeps. SIGINT must invoke gracefulShutdown → cleanup → release.
      const script = `
        import { LockManager } from ${JSON.stringify(MODULE_PATH)};
        import { ShutdownManager } from ${JSON.stringify(SHUTDOWN_PATH)};
        const mgr = new LockManager({ locksDir: ${JSON.stringify(dir)} });
        const r = mgr.acquire(77, "sigint-test");
        if (!r.acquired) { process.stdout.write("ACQUIRE_FAILED\\n"); process.exit(2); }
        const shutdown = new ShutdownManager({ forceExitTimeout: 5000 });
        shutdown.registerCleanup("Release locks", async () => { mgr.releaseAll(); });
        process.stdout.write("READY pid=" + process.pid + "\\n");
        // Hold indefinitely — SIGINT path is what releases.
        setInterval(() => {}, 1000);
      `;
      const child = spawn(TSX_BIN, ["--eval", script], {
        env: { ...process.env, SEQUANT_ORCHESTRATOR: "" },
      });
      let stdoutBuf = "";
      child.stdout.on("data", (b) => (stdoutBuf += b.toString()));
      child.stderr.on("data", () => {}); // drain

      // Wait for the child to report ready.
      const childPid = await new Promise<number>((res, rej) => {
        const t = setTimeout(
          () => rej(new Error("child did not report ready: " + stdoutBuf)),
          10_000,
        );
        const i = setInterval(() => {
          const m = stdoutBuf.match(/READY pid=(\d+)/);
          if (m) {
            clearInterval(i);
            clearTimeout(t);
            res(Number.parseInt(m[1], 10));
          }
        }, 50);
      });

      // Lock should exist on disk at this point.
      expect(existsSync(join(dir, "77.lock"))).toBe(true);

      // SIGINT the actual Node process running our script (not the npx wrapper).
      try {
        process.kill(childPid, "SIGINT");
      } catch {
        child.kill("SIGINT");
      }

      // Wait for the child to exit gracefully.
      const exitCode = await new Promise<number | null>((res) => {
        child.on("exit", (code) => res(code));
      });

      // ShutdownManager calls process.exit(130) on SIGINT after cleanup runs.
      // The lock file must be gone — that's the AC-16 guarantee.
      expect(existsSync(join(dir, "77.lock"))).toBe(false);
      // Sanity: child exited; exit code may be 130 (SIGINT) or 0 depending
      // on whether the interval keeps the loop alive past cleanup.
      expect(exitCode === 130 || exitCode === 0).toBe(true);
    },
  );
});
