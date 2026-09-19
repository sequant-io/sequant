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
import { resolveNpxCommand, sweepStaleLaunchDirs } from "./mcp-launch.mjs";

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
});
