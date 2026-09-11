/**
 * `decideOpencodeShimSync` is content-aware (#1030, second-pass fix).
 *
 * Real filesystem, no mocks: the helper renders the shim with the same
 * writers `init` uses and compares against a temp project. A presence-only
 * decision made every opencode project permanently "pending" (dry-run exit 1
 * forever; non-interactive `update` refusing with nothing to do).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { decideOpencodeShimSync, refreshOpencodeShim } from "./init.js";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "sequant-shim-decision-"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("decideOpencodeShimSync (#1030)", () => {
  it("is 'none' when the project has no .opencode/", async () => {
    expect(await decideOpencodeShimSync(project)).toBe("none");
  });

  it("is 'current' right after the writers ran, and stays so on a second look", async () => {
    await refreshOpencodeShim(project);
    expect(await decideOpencodeShimSync(project)).toBe("current");
    // Idempotent: a second refresh changes nothing.
    await refreshOpencodeShim(project);
    expect(await decideOpencodeShimSync(project)).toBe("current");
  });

  it("is 'refresh' when a rendered command drifts, and 'current' again after a refresh", async () => {
    await refreshOpencodeShim(project);
    const cmd = join(project, ".opencode/commands/exec.md");
    await writeFile(cmd, `${await readFile(cmd, "utf-8")}\n<!-- stale -->\n`);
    expect(await decideOpencodeShimSync(project)).toBe("refresh");
    await refreshOpencodeShim(project);
    expect(await decideOpencodeShimSync(project)).toBe("current");
  });

  it("is 'refresh' when a plugin file is missing", async () => {
    await refreshOpencodeShim(project);
    await unlink(join(project, ".opencode/plugin/lib/sequant-hooks-core.ts"));
    expect(await decideOpencodeShimSync(project)).toBe("refresh");
  });

  it("is 'refresh' when the MCP config lost sequant's entry, but 'current' when the user added their own entries", async () => {
    await refreshOpencodeShim(project);
    const configPath = join(project, ".opencode/opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    // A user-added server must not count as drift — the writer merges.
    config.mcp.theirs = { type: "local", command: ["their-server"] };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    expect(await decideOpencodeShimSync(project)).toBe("current");
    delete config.mcp.sequant;
    await writeFile(configPath, JSON.stringify(config, null, 2));
    expect(await decideOpencodeShimSync(project)).toBe("refresh");
  });
});
