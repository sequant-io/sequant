// Tests for Issue #784 — the pre-tool.sh plugin staleness check.
//
// Claude Code pins plugin installs to a commit SHA and never auto-updates
// them, so an installed cache can silently run months-old skills/hooks while
// the marketplace clone on the same disk tracks main. The hook compares the
// running plugin's version (.claude-plugin/plugin.json next to the cache's
// hooks/ dir) against the local marketplace clone's marketplace.json and
// emits ONE warn-only stderr line, rate-limited to once per day via a stamp
// file, with zero network access.
//
// The check is gated on the script's own resolved path containing
// */plugins/cache/*, so these tests stage each hook copy into a simulated
// cache tree (plugins/cache/sequant/sequant/<ver>/hooks/) — the same layout
// Claude Code uses — and drive it exactly the way Claude Code does: bash on
// the script with the tool payload on stdin.
//
// The hook script is mirrored across three locations (templates/hooks/,
// hooks/, and .claude/hooks/), none of which are symlinks. To prevent drift
// in any one copy, every assertion is parametrized over all three.

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const HOOK_COPIES: Array<[label: string, path: string]> = [
  [
    "templates/hooks/pre-tool.sh",
    join(REPO_ROOT, "templates", "hooks", "pre-tool.sh"),
  ],
  ["hooks/pre-tool.sh", join(REPO_ROOT, "hooks", "pre-tool.sh")],
  [
    ".claude/hooks/pre-tool.sh",
    join(REPO_ROOT, ".claude", "hooks", "pre-tool.sh"),
  ],
];

const WARNING_REMEDY = "claude plugin update sequant@sequant";

// Every staged install and data dir lives under one disposable root.
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface StagedInstall {
  /** Path to the staged hook inside the fake plugin cache. */
  hookPath: string;
  /** Root of the fake ~/.claude-style plugins tree. */
  root: string;
}

/**
 * Stage a hook copy into a simulated Claude Code plugin layout:
 *
 *   <root>/plugins/cache/sequant/sequant/<runningVersion>/hooks/pre-tool.sh
 *   <root>/plugins/cache/sequant/sequant/<runningVersion>/.claude-plugin/plugin.json
 *   <root>/plugins/marketplaces/sequant/.claude-plugin/marketplace.json
 *
 * Pass `marketplaceJson: null` to omit the marketplace clone entirely, or a
 * string to control its exact (possibly unparsable) content.
 */
function stageInstall(
  hookSource: string,
  runningVersion: string,
  marketplaceJson: string | null,
): StagedInstall {
  const root = mkdtempSync(join(tmpdir(), "plugin-stale-"));
  roots.push(root);

  const pluginRoot = join(
    root,
    "plugins",
    "cache",
    "sequant",
    "sequant",
    runningVersion,
  );
  mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  cpSync(hookSource, join(pluginRoot, "hooks", "pre-tool.sh"));
  writeFileSync(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "sequant", version: runningVersion }, null, 2),
  );

  if (marketplaceJson !== null) {
    const marketDir = join(
      root,
      "plugins",
      "marketplaces",
      "sequant",
      ".claude-plugin",
    );
    mkdirSync(marketDir, { recursive: true });
    writeFileSync(join(marketDir, "marketplace.json"), marketplaceJson);
  }

  return { hookPath: join(pluginRoot, "hooks", "pre-tool.sh"), root };
}

function marketplaceWithVersion(version: string): string {
  return JSON.stringify(
    {
      name: "sequant",
      owner: { name: "sequant-io" },
      plugins: [{ name: "sequant", version, source: "./" }],
    },
    null,
    2,
  );
}

/**
 * Run a hook the way Claude Code does. Each call gets its own
 * CLAUDE_PLUGIN_DATA dir by default so the daily stamp never leaks between
 * tests; pass `dataDir` to share one across calls (the rate-limit tests).
 */
function runHook(
  hookPath: string,
  opts: { command?: string; dataDir?: string } = {},
): { code: number; stderr: string; dataDir: string } {
  const dataDir =
    opts.dataDir ?? mkdtempSync(join(tmpdir(), "plugin-stale-data-"));
  if (!opts.dataDir) roots.push(dataDir);

  const env = { ...process.env };
  delete env.SEQUANT_WORKTREE;
  delete env.SEQUANT_ISSUE;
  delete env.CLAUDE_HOOKS_DISABLED;
  env.CLAUDE_PLUGIN_DATA = dataDir;

  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: opts.command ?? "echo hi" },
  });
  const result = spawnSync("bash", [hookPath], {
    input: payload,
    env,
    encoding: "utf8",
  });
  return {
    code: result.status ?? -1,
    stderr: result.stderr ?? "",
    dataDir,
  };
}

function warningLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.includes("is stale (marketplace has"));
}

describe.each(HOOK_COPIES)(
  "pre-tool.sh plugin staleness check (#784) [%s]",
  (_label, hookSource) => {
    // AC-1 + AC-2: version mismatch from a cache path warns on stderr with
    // the exact remedy, without blocking the tool call.
    it("AC-1/AC-2: warns once on stderr with the exact remedy and exit 0", () => {
      const { hookPath } = stageInstall(
        hookSource,
        "1.20.3",
        marketplaceWithVersion("2.8.0"),
      );
      const { code, stderr } = runHook(hookPath);

      expect(code).toBe(0);
      const lines = warningLines(stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("sequant plugin v1.20.3 is stale");
      expect(lines[0]).toContain("marketplace has v2.8.0");
      expect(lines[0]).toContain(WARNING_REMEDY);
      expect(lines[0]).toContain("restart Claude Code");
    });

    // AC-2: the warning must not change the hook's verdict in either
    // direction — a command the guards would block still blocks (exit 2),
    // with the warning riding along on stderr.
    it("AC-2: a blocked command still exits 2 when the warning fires", () => {
      const { hookPath } = stageInstall(
        hookSource,
        "1.20.3",
        marketplaceWithVersion("2.8.0"),
      );
      const { code, stderr } = runHook(hookPath, {
        command: "git push --force origin main",
      });

      expect(code).toBe(2);
      expect(stderr).toContain("HOOK_BLOCKED: Force push");
      expect(warningLines(stderr)).toHaveLength(1);
    });

    // AC-3: the stamp file rate-limits to at most one warning per day.
    it("AC-3: does not warn twice on the same day (stamp file)", () => {
      const { hookPath } = stageInstall(
        hookSource,
        "1.20.3",
        marketplaceWithVersion("2.8.0"),
      );
      const first = runHook(hookPath);
      expect(warningLines(first.stderr)).toHaveLength(1);

      const second = runHook(hookPath, { dataDir: first.dataDir });
      expect(second.code).toBe(0);
      expect(warningLines(second.stderr)).toHaveLength(0);
    });

    // AC-4: equal versions are a silent no-op.
    it("AC-4: no warning when versions are equal", () => {
      const { hookPath } = stageInstall(
        hookSource,
        "2.8.0",
        marketplaceWithVersion("2.8.0"),
      );
      const { code, stderr } = runHook(hookPath);
      expect(code).toBe(0);
      expect(warningLines(stderr)).toHaveLength(0);
    });

    // AC-4: a missing marketplace clone is a silent no-op.
    it("AC-4: no warning when the marketplace clone is missing", () => {
      const { hookPath } = stageInstall(hookSource, "1.20.3", null);
      const { code, stderr } = runHook(hookPath);
      expect(code).toBe(0);
      expect(warningLines(stderr)).toHaveLength(0);
    });

    // AC-4: an unparsable marketplace.json (no version key) is a silent no-op.
    it("AC-4: no warning when marketplace.json has no version", () => {
      const { hookPath } = stageInstall(
        hookSource,
        "1.20.3",
        '{"name": "sequant", "plugins": []}',
      );
      const { code, stderr } = runHook(hookPath);
      expect(code).toBe(0);
      expect(warningLines(stderr)).toHaveLength(0);
    });

    // AC-4: repo-local dev copies (the file at its real path, outside any
    // */plugins/cache/* tree) never warn, even with a stale marketplace
    // clone present on the machine.
    it("AC-4: the repo-local copy never warns", () => {
      const { code, stderr } = runHook(hookSource);
      expect(code).toBe(0);
      expect(warningLines(stderr)).toHaveLength(0);
    });
  },
);
