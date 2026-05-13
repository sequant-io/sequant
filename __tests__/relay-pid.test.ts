// Tests for relay PID tracking (#383):
// AC-20 (.sequant/pids/<issue>.pid), AC-21 (LockManager.isPidAlive reuse),
// AC-22 (stale cleanup), AC-D3 (SIGKILL'd run cleanup).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  writePidFile,
  readPidFile,
  removePidFile,
  cleanupStalePid,
  isPidAlive,
} from "../src/lib/relay/pid.js";
import { defaultIsPidAlive } from "../src/lib/locks/lock-manager.js";
import { pidPathFor } from "../src/lib/relay/paths.js";

const ISSUE = 383;

function makeTmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-pid-"));
}

describe("Relay PID Tracking", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmpCwd();
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // === AC-20: .sequant/pids/<issue>.pid written at run start ===
  describe("AC-20: PID file is written when a run starts", () => {
    it("writes .sequant/pids/<issue>.pid containing process.pid", () => {
      const written = writePidFile(ISSUE, 12345, cwd);
      expect(written).toBe(pidPathFor(ISSUE, cwd));
      const raw = fs.readFileSync(written, "utf-8");
      expect(raw.trim()).toBe("12345");
    });

    it("creates the pids directory if missing", () => {
      writePidFile(ISSUE, process.pid, cwd);
      const dir = path.join(cwd, ".sequant", "pids");
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("readPidFile returns null when no pidfile present", () => {
      expect(readPidFile(ISSUE, cwd)).toBeNull();
    });

    it("readPidFile returns the integer PID", () => {
      writePidFile(ISSUE, 4242, cwd);
      expect(readPidFile(ISSUE, cwd)).toBe(4242);
    });

    it("readPidFile returns null on malformed contents", () => {
      const p = pidPathFor(ISSUE, cwd);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "not-a-number");
      expect(readPidFile(ISSUE, cwd)).toBeNull();
    });
  });

  // === AC-21: Reuse LockManager.isPidAlive ===
  describe("AC-21: Liveness reuses LockManager.isPidAlive", () => {
    it("re-exports the same defaultIsPidAlive from locks", () => {
      expect(isPidAlive).toBe(defaultIsPidAlive);
    });

    it("returns true for the current process", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("returns false for a clearly dead PID", () => {
      // 0x7fffffff is the max signed 32-bit int; almost certainly not in use.
      expect(isPidAlive(0x7fffffff)).toBe(false);
    });
  });

  // === AC-22: Stale PID cleanup + warning ===
  describe("AC-22: Stale PID cleanup + warning", () => {
    it("returns alive=false, cleaned=false, pid=null when no pidfile", () => {
      const r = cleanupStalePid(ISSUE, { cwd });
      expect(r.cleaned).toBe(false);
      expect(r.alive).toBe(false);
      expect(r.pid).toBeNull();
      expect(r.warning).toBeNull();
    });

    it("returns alive=true, cleaned=false when PID is alive", () => {
      writePidFile(ISSUE, process.pid, cwd);
      const r = cleanupStalePid(ISSUE, {
        cwd,
        isAlive: () => true,
      });
      expect(r.alive).toBe(true);
      expect(r.cleaned).toBe(false);
      expect(r.pid).toBe(process.pid);
    });

    it("removes pidfile and emits warning when PID is dead (AC-D3)", () => {
      writePidFile(ISSUE, 99999, cwd);
      const r = cleanupStalePid(ISSUE, {
        cwd,
        isAlive: () => false,
      });
      expect(r.cleaned).toBe(true);
      expect(r.alive).toBe(false);
      expect(r.pid).toBe(99999);
      expect(r.warning).toMatch(/no longer active/);
      expect(fs.existsSync(pidPathFor(ISSUE, cwd))).toBe(false);
    });

    it("removePidFile returns false when no file present", () => {
      expect(removePidFile(ISSUE, cwd)).toBe(false);
    });

    it("removePidFile returns true after successful removal", () => {
      writePidFile(ISSUE, 1234, cwd);
      expect(removePidFile(ISSUE, cwd)).toBe(true);
      expect(fs.existsSync(pidPathFor(ISSUE, cwd))).toBe(false);
    });
  });
});
