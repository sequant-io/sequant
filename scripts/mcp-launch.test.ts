// #1084 QA follow-up: `spawn("npx", …, { shell: false })` raises ENOENT on
// Windows because npm ships `npx` as `npx.cmd` and shell:false skips PATHEXT
// resolution — a regression versus the previous shell-resolved `"command":
// "npx"` config. resolveNpxCommand() is the fix; this pins its behavior per
// platform without needing an actual Windows box.
//
// Mutation-verified: reverting resolveNpxCommand() to always return "npx"
// fails the win32 case below.

import { describe, it, expect } from "vitest";
import { resolveNpxCommand } from "./mcp-launch.mjs";

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
