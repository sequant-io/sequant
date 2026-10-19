/**
 * Tests for the main assessment module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateVersion,
  checkGhCliAvailable,
  fetchRelease,
  listReleases,
  getReleasesSince,
  loadBaseline,
  isAlreadyAssessed,
} from "../assessment.js";
import {
  analyzeChange,
  mappedPathExists,
  selectIssueWorthy,
} from "../relevance.js";
import type { Baseline, Finding } from "../types.js";
import { readFile, access } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Mock GitHubProvider as a class constructor — required because both assessment.ts
// and issues.ts call `new GitHubProvider()` at module scope.
// vi.hoisted() ensures these are available when the hoisted vi.mock factory runs.
const {
  mockCheckGhInstalledSync,
  mockCheckAuthSync,
  mockFetchReleaseSync,
  mockListReleasesSync,
} = vi.hoisted(() => ({
  mockCheckGhInstalledSync: vi.fn().mockReturnValue(true),
  mockCheckAuthSync: vi.fn().mockReturnValue(true),
  mockFetchReleaseSync: vi.fn().mockReturnValue(null),
  mockListReleasesSync: vi.fn().mockReturnValue([]),
}));

vi.mock("../../workflow/platforms/github.js", () => {
  function MockGitHubProvider() {
    return {
      checkGhInstalledSync: mockCheckGhInstalledSync,
      checkAuthSync: mockCheckAuthSync,
      fetchReleaseSync: mockFetchReleaseSync,
      listReleasesSync: mockListReleasesSync,
      searchIssuesSync: vi.fn().mockReturnValue([]),
      createIssueWithBodyFileSync: vi.fn().mockReturnValue(null),
      commentOnIssueWithBodyFileSync: vi.fn().mockReturnValue(false),
    };
  }
  return { GitHubProvider: MockGitHubProvider };
});

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
}));

describe("validateVersion", () => {
  it("accepts valid semver versions", () => {
    expect(() => validateVersion("v1.0.0")).not.toThrow();
    expect(() => validateVersion("v2.1.29")).not.toThrow();
    expect(() => validateVersion("1.0.0")).not.toThrow();
    expect(() => validateVersion("0.0.1")).not.toThrow();
    expect(() => validateVersion("10.20.30")).not.toThrow();
  });

  it("accepts versions with prerelease tags", () => {
    expect(() => validateVersion("v1.0.0-beta")).not.toThrow();
    expect(() => validateVersion("v1.0.0-beta.1")).not.toThrow();
    expect(() => validateVersion("v1.0.0-rc1")).not.toThrow();
    expect(() => validateVersion("1.0.0-alpha.2")).not.toThrow();
    expect(() => validateVersion("v1.0.0-canary.123")).not.toThrow();
  });

  it("rejects invalid version formats", () => {
    expect(() => validateVersion("invalid")).toThrow(/Invalid version format/);
    expect(() => validateVersion("1.0")).toThrow(/Invalid version format/);
    expect(() => validateVersion("v1")).toThrow(/Invalid version format/);
    expect(() => validateVersion("")).toThrow(/Invalid version format/);
    expect(() => validateVersion("latest")).toThrow(/Invalid version format/);
  });

  it("rejects versions with shell metacharacters", () => {
    expect(() => validateVersion("v1.0.0; echo test")).toThrow();
    expect(() => validateVersion("v1.0.0 && echo pwned")).toThrow();
    expect(() => validateVersion("v1.0.0 | cat")).toThrow();
    expect(() => validateVersion("$(whoami)")).toThrow();
    expect(() => validateVersion("v1.0.0\necho")).toThrow();
  });
});

describe("checkGhCliAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to defaults (installed + authenticated)
    mockCheckGhInstalledSync.mockReturnValue(true);
    mockCheckAuthSync.mockReturnValue(true);
  });

  it("returns available and authenticated when gh works", async () => {
    const result = await checkGhCliAvailable();

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns not available when gh is not installed", async () => {
    mockCheckGhInstalledSync.mockReturnValue(false);

    const result = await checkGhCliAvailable();

    expect(result.available).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("not installed");
  });

  it("returns not authenticated when gh auth fails", async () => {
    mockCheckAuthSync.mockReturnValue(false);

    const result = await checkGhCliAvailable();

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("not authenticated");
  });
});

describe("loadBaseline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads baseline from file when it exists", async () => {
    const mockBaseline = {
      lastAssessedVersion: "v2.1.25",
      schemaVersion: "1.0.0",
      tools: { core: ["Task"], optional: [] },
      hooks: { used: [], files: [] },
      mcpServers: { required: [], optional: [] },
      permissions: { patterns: [], files: [] },
      keywords: ["Task"],
      dependencyMap: {},
    };

    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockBaseline));

    const result = await loadBaseline("/test/path/baseline.json");

    expect(result.lastAssessedVersion).toBe("v2.1.25");
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.tools.core).toContain("Task");
  });

  it("returns default baseline when file does not exist", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));

    const result = await loadBaseline("/nonexistent/baseline.json");

    // Should return default baseline
    expect(result.lastAssessedVersion).toBeNull();
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.tools.core).toContain("Task");
    expect(result.tools.core).toContain("Bash");
  });

  it("returns default baseline when file contains invalid JSON", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("not valid json {{{");

    const result = await loadBaseline("/test/path/baseline.json");

    // Should return default baseline on parse error
    expect(result.lastAssessedVersion).toBeNull();
  });
});

describe("isAlreadyAssessed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when report file exists", async () => {
    vi.mocked(access).mockResolvedValueOnce(undefined);

    const result = await isAlreadyAssessed("v2.1.29");

    expect(result).toBe(true);
  });

  it("returns false when report file does not exist", async () => {
    vi.mocked(access).mockRejectedValueOnce(new Error("ENOENT"));

    const result = await isAlreadyAssessed("v2.1.29");

    expect(result).toBe(false);
  });
});

describe("fetchRelease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchReleaseSync.mockReturnValue(null);
  });

  it("returns release data on success", async () => {
    const release = {
      tagName: "v2.1.29",
      name: "v2.1.29",
      body: "Release notes",
      publishedAt: "2026-01-01",
    };
    mockFetchReleaseSync.mockReturnValue(release);

    const result = await fetchRelease("v2.1.29");

    expect(result).toEqual(release);
  });

  it("returns null when provider returns null", async () => {
    mockFetchReleaseSync.mockReturnValue(null);

    const result = await fetchRelease("v2.1.29");

    expect(result).toBeNull();
  });

  it("fetches latest when no version given", async () => {
    mockFetchReleaseSync.mockReturnValue({ tagName: "v3.0.0" });

    await fetchRelease();

    expect(mockFetchReleaseSync).toHaveBeenCalledWith(
      "anthropics/claude-code",
      undefined,
    );
  });

  it("returns null on invalid version (caught by try/catch)", async () => {
    const result = await fetchRelease("not-a-version");

    expect(result).toBeNull();
    expect(mockFetchReleaseSync).not.toHaveBeenCalled();
  });

  it("passes correct repo and version", async () => {
    mockFetchReleaseSync.mockReturnValue({ tagName: "v2.1.29" });

    await fetchRelease("v2.1.29");

    expect(mockFetchReleaseSync).toHaveBeenCalledWith(
      "anthropics/claude-code",
      "v2.1.29",
    );
  });
});

describe("listReleases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListReleasesSync.mockReturnValue([]);
  });

  it("returns releases on success", async () => {
    const releases = [
      { tagName: "v2.1.29", publishedAt: "2026-01-01" },
      { tagName: "v2.1.28", publishedAt: "2025-12-15" },
    ];
    mockListReleasesSync.mockReturnValue(releases);

    const result = await listReleases();

    expect(result).toEqual(releases);
  });

  it("returns empty array when provider returns empty", async () => {
    const result = await listReleases();

    expect(result).toEqual([]);
  });

  it("returns empty on limit of 0 (caught)", async () => {
    const result = await listReleases(0);

    expect(result).toEqual([]);
    expect(mockListReleasesSync).not.toHaveBeenCalled();
  });

  it("returns empty on limit over 100 (caught)", async () => {
    const result = await listReleases(101);

    expect(result).toEqual([]);
    expect(mockListReleasesSync).not.toHaveBeenCalled();
  });

  it("returns empty on non-integer limit (caught)", async () => {
    const result = await listReleases(1.5);

    expect(result).toEqual([]);
    expect(mockListReleasesSync).not.toHaveBeenCalled();
  });

  it("passes correct repo and limit", async () => {
    mockListReleasesSync.mockReturnValue([]);

    await listReleases(10);

    expect(mockListReleasesSync).toHaveBeenCalledWith(
      "anthropics/claude-code",
      10,
    );
  });
});

describe("getReleasesSince", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListReleasesSync.mockReturnValue([]);
  });

  it("returns versions after the target (oldest first)", async () => {
    mockListReleasesSync.mockReturnValue([
      { tagName: "v2.1.30", publishedAt: "2026-02-01" },
      { tagName: "v2.1.29", publishedAt: "2026-01-15" },
      { tagName: "v2.1.28", publishedAt: "2026-01-01" },
    ]);

    const result = await getReleasesSince("v2.1.29");

    // Should return only v2.1.30 (the one newer than v2.1.29), reversed to oldest first
    expect(result).toEqual(["v2.1.30"]);
  });

  it("throws when baseline not found among the fetched releases", async () => {
    mockListReleasesSync.mockReturnValue([
      { tagName: "v2.1.30", publishedAt: "2026-02-01" },
      { tagName: "v2.1.29", publishedAt: "2026-01-15" },
    ]);

    await expect(getReleasesSince("v1.0.0")).rejects.toThrow(
      /v1\.0\.0 not found among the 2 most recent releases/,
    );
  });

  it("returns empty when no releases", async () => {
    mockListReleasesSync.mockReturnValue([]);

    const result = await getReleasesSince("v2.1.29");

    expect(result).toEqual([]);
  });
});

// #1186: per-finding issues only for changes that touch something sequant uses.
// Reads the real baseline with node:fs (only node:fs/promises is mocked).
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const realBaseline = (): Baseline =>
  JSON.parse(
    readFileSync(resolve(repoRoot, ".sequant/upstream/baseline.json"), "utf8"),
  ) as Baseline;
const existsInRepo = (p: string) => existsSync(resolve(repoRoot, p));

describe("issue filing relevance (#1186)", () => {
  // The six v2.1.283 notes behind #1172–#1177, all closed not-planned.
  const v2_1_283_notes = [
    "Added MCP tool, WebFetch and WebSearch outputs to the `tool.output` OpenTelemetry span event when `OTEL_LOG_TOOL_CONTENT=1`",
    "Fixed `claude plugin marketplace remove` not saying which installed plugins it uninstalled with the marketplace; it now lists them",
    "Fixed `claude plugin uninstall` removing the other of two installed plugins whose ids differ only in case, with its options and secrets, when the one named had no `enabledPlugins` entry at that scope",
    "Fixed `claude mcp add`, `add-json`, and `remove` reporting success when the user or local config file could not be written, for example inside a sandbox",
    "Windows: Fixed the PowerShell tool letting `cmd /c rd`, `rmdir`, `del` or `erase` delete drive roots, the home folder and other folders that `Remove-Item` refuses",
    "Self-hosted runner: Changed lifecycle hooks' git to skip a repository's Git LFS `pre-push` hook, ignore a writable system `core.hooksPath`, and not sign commits without `--configure-git`",
  ];

  it("relevance: the six v2.1.283 notes behind #1172–#1177 file no issue", () => {
    const baseline = realBaseline();
    const findings = v2_1_283_notes.map((n) => analyzeChange(n, baseline));

    // Non-vacuous: a category-only filter would still file some of these.
    expect(
      findings.filter(
        (f) => f.category !== "opportunity" && f.category !== "no-action",
      ).length,
    ).toBeGreaterThan(0);

    expect(selectIssueWorthy(findings, baseline, existsInRepo)).toEqual([]);
  });

  it("relevance: a hook change naming a hook event sequant uses files an issue", () => {
    const baseline = realBaseline();
    const finding = analyzeChange(
      "Changed PreToolUse hooks to receive the tool input as a file path",
      baseline,
    );
    expect(finding.category).toBe("hook-change");
    expect(selectIssueWorthy([finding], baseline, existsInRepo)).toEqual([
      finding,
    ]);
  });

  it("relevance: a hook change naming a command sequant documents files an issue", () => {
    const baseline = realBaseline();
    const finding = analyzeChange(
      "Fixed `claude plugin update` not reloading a plugin's hook config",
      baseline,
    );
    expect(finding.category).toBe("hook-change");
    expect(selectIssueWorthy([finding], baseline, existsInRepo)).toHaveLength(
      1,
    );
  });

  it("relevance: lowercase words don't match tool names", () => {
    const baseline = realBaseline();
    const finding = analyzeChange(
      "Changed hook output so a background task can read and edit its log",
      baseline,
    );
    expect(finding.category).toBe("hook-change");
    expect(finding.sequantFiles).toEqual([]);
    expect(selectIssueWorthy([finding], baseline, existsInRepo)).toEqual([]);
  });

  it("breaking always gets an issue, even when it names nothing sequant uses", () => {
    const finding: Finding = {
      category: "breaking",
      title: "BREAKING: Removed the legacy telemetry exporter",
      description: "Breaking: removed the legacy telemetry exporter",
      impact: "high",
      matchedKeywords: [],
      matchedPatterns: ["breaking"],
      sequantFiles: [],
    };
    expect(selectIssueWorthy([finding], realBaseline(), () => false)).toEqual([
      finding,
    ]);
  });

  it("dependency map paths exist", () => {
    const baseline = realBaseline();
    const paths = [
      ...Object.values(baseline.dependencyMap).flat(),
      ...baseline.hooks.files,
    ];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => !mappedPathExists(p, existsInRepo))).toEqual([]);
  });

  it("dependency map paths exist: a glob counts by its directory prefix", () => {
    expect(mappedPathExists(".claude/skills/**/*.md", existsInRepo)).toBe(true);
    expect(mappedPathExists("src/hooks/**/*.ts", existsInRepo)).toBe(false);
  });
});
