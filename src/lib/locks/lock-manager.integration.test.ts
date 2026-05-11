/**
 * Integration tests for LockManager (#625).
 *
 * Spawn real child processes to exercise the `open(O_CREAT | O_EXCL)`
 * atomicity guarantee under concurrent contention. These complement the
 * mocked unit tests in `lock-manager.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = resolve(__dirname, "lock-manager.ts");

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
  const result = spawnSync("npx", ["tsx", "--eval", script], {
    encoding: "utf-8",
    env: { ...process.env, SEQUANT_ORCHESTRATOR: "" },
  });
  if (result.status !== 0) {
    throw new Error(`tsx failed: ${result.stderr}`);
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
      // Spawn process A — acquires and holds for 1s.
      const script = `
        import { LockManager } from ${JSON.stringify(MODULE_PATH)};
        const mgr = new LockManager({ locksDir: ${JSON.stringify(dir)} });
        const r = mgr.acquire(42, "first");
        process.stdout.write(JSON.stringify(r) + "\\n");
        setTimeout(() => { mgr.release(42); process.exit(0); }, 1000);
      `;
      const child = spawn("npx", ["tsx", "--eval", script], {
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

      // Process B should be blocked.
      const b = runAcquireSync(dir, 42, "second");
      expect(b.acquired).toBe(false);

      // Wait for A to release.
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
      const child = spawn("npx", ["tsx", "--eval", script], {
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
});
