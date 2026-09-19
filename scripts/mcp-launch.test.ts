// #1084 QA follow-up: `spawn("npx", …, { shell: false })` raises ENOENT on
// Windows because npm ships `npx` as `npx.cmd` and shell:false skips PATHEXT
// resolution — a regression versus the previous shell-resolved `"command":
// "npx"` config. resolveNpxCommand() is the fix; this pins its behavior per
// platform without needing an actual Windows box.
//
// Mutation-verified: reverting resolveNpxCommand() to always return "npx"
// fails the win32 case below.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isProcessAlive,
  isSafeSpec,
  resolveNpxCommand,
  spawnShellFor,
  sweepStaleLaunchDirs,
} from "./mcp-launch.mjs";

describe("#1084: resolveNpxCommand picks the platform-correct npx binary", () => {
  it("uses npx.cmd on win32", () => {
    expect(resolveNpxCommand("win32")).toBe("npx.cmd");
  });

  it("uses plain npx on darwin and linux", () => {
    expect(resolveNpxCommand("darwin")).toBe("npx");
    expect(resolveNpxCommand("linux")).toBe("npx");
  });

  it("defaults to process.platform when called with no argument", () => {
    expect(resolveNpxCommand()).toBe(
      process.platform === "win32" ? "npx.cmd" : "npx",
    );
  });
});

// #1084 QA follow-up: cleanup() runs on the child's exit, so a SIGKILL of the
// launcher itself leaks its empty mkdtemp dir. sweepStaleLaunchDirs() removes
// such leftovers on the next launch — but only ours (prefix), only old ones
// (a sibling launcher's fresh dir must survive), and only empty ones.
//
// Mutation-verified: dropping the age check removes the fresh sibling dir and
// fails "leaves a fresh sibling launcher's directory alone".
describe("#1084: sweepStaleLaunchDirs removes only old, empty, launcher-owned dirs", () => {
  let base: string;
  const HOUR = 60 * 60 * 1000;
  const now = Date.now();

  function mkdir(name: string, ageMs: number): string {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    const t = (now - ageMs) / 1000;
    fs.utimesSync(dir, t, t);
    return dir;
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-sweep-test-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("removes an empty launcher dir older than the max age", () => {
    const stale = mkdir("sequant-mcp-launch-stale1", 2 * HOUR);
    expect(sweepStaleLaunchDirs(base, HOUR, now)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("leaves a fresh sibling launcher's directory alone", () => {
    const fresh = mkdir("sequant-mcp-launch-fresh1", 5_000);
    expect(sweepStaleLaunchDirs(base, HOUR, now)).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("never removes a non-empty directory or one without the launcher prefix", () => {
    const busy = mkdir("sequant-mcp-launch-busy1", 2 * HOUR);
    fs.writeFileSync(path.join(busy, "keep.txt"), "x");
    fs.utimesSync(busy, (now - 2 * HOUR) / 1000, (now - 2 * HOUR) / 1000);
    const other = mkdir("someone-elses-dir", 2 * HOUR);
    expect(sweepStaleLaunchDirs(base, HOUR, now)).toBe(0);
    expect(fs.existsSync(busy)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("returns 0 when the base directory does not exist", () => {
    expect(sweepStaleLaunchDirs(path.join(base, "missing"), HOUR, now)).toBe(0);
  });

  // pid-file ownership (#1084 QA follow-up): a live session's launch dir is
  // empty and its mtime never advances, so age alone would sweep it after an
  // hour — and with a pre-2.16 `serve` pinned that dir is the server's cwd.
  it("never removes a directory whose launcher pid is still alive, however old", () => {
    const live = mkdir("sequant-mcp-launch-live1", 5 * HOUR);
    fs.writeFileSync(path.join(live, "launcher.pid"), String(process.pid));
    fs.utimesSync(live, (now - 5 * HOUR) / 1000, (now - 5 * HOUR) / 1000);
    expect(sweepStaleLaunchDirs(base, HOUR, now)).toBe(0);
    expect(fs.existsSync(live)).toBe(true);
  });

  it("removes a directory whose launcher pid is dead, even if fresh and non-empty", () => {
    const dead = mkdir("sequant-mcp-launch-dead1", 1_000);
    fs.writeFileSync(path.join(dead, "launcher.pid"), "2147483647");
    expect(sweepStaleLaunchDirs(base, HOUR, now, () => false)).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it("consults the injected liveness check with the recorded pid", () => {
    const d = mkdir("sequant-mcp-launch-pid1", 1_000);
    fs.writeFileSync(path.join(d, "launcher.pid"), "424242");
    const seen: number[] = [];
    sweepStaleLaunchDirs(base, HOUR, now, (pid) => {
      seen.push(pid);
      return true;
    });
    expect(seen).toEqual([424242]);
    expect(fs.existsSync(d)).toBe(true);
  });
});

describe("#1084: isProcessAlive", () => {
  it("is true for this process and false for a pid that cannot exist", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2147483647)).toBe(false);
  });
});

// Node refuses to spawn `npx.cmd` without a shell (CVE-2024-27980
// hardening), so Windows must go through cmd.exe — and then the spec must be
// shell-safe. Mutation-verified: making spawnShellFor() return false on win32
// fails the first case; loosening isSafeSpec()'s charset fails the rejects.
describe("#1084: Windows spawns through a shell, gated by isSafeSpec", () => {
  it("uses a shell only on win32", () => {
    expect(spawnShellFor("win32")).toBe(true);
    expect(spawnShellFor("darwin")).toBe(false);
    expect(spawnShellFor("linux")).toBe(false);
  });

  it("accepts ordinary and scoped package specs", () => {
    expect(isSafeSpec("sequant@2.15.1")).toBe(true);
    expect(isSafeSpec("sequant@latest")).toBe(true);
    expect(isSafeSpec("@scope/pkg@1.0.0-rc.1")).toBe(true);
  });

  it("rejects anything a shell could interpret", () => {
    for (const bad of [
      "sequant@2.15.1; rm -rf ~",
      "sequant@2.15.1 && whoami",
      "sequant@$(id)",
      "sequant@`id`",
      "sequant@2.15.1|cat",
      "sequant@2.15.1 >out",
      'sequant@"2.15.1"',
      "",
      undefined,
    ]) {
      expect(isSafeSpec(bad as string), String(bad)).toBe(false);
    }
  });
});
