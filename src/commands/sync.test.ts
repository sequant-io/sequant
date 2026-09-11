import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs functions
vi.mock("../lib/fs.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getFileStats: vi.fn(),
}));

// Mock manifest
vi.mock("../lib/manifest.js", () => ({
  getManifest: vi.fn(),
  updateManifest: vi.fn(),
  getPackageVersion: vi.fn(() => "1.1.0"),
}));

// Mock templates. `isCustomizableFile` is a pure allow-list check, so mirror
// the real implementation rather than a bare vi.fn() (sync.ts calls it to
// classify the write-set). `processTemplate` is kept real (via importOriginal)
// since generateAgentsMd (also real/unmocked in this file) depends on it.
vi.mock("../lib/templates.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    copyTemplates: vi.fn(),
    computeTemplateChanges: vi.fn(),
    listTemplateFiles: vi.fn(),
    getTemplatesDir: vi.fn(() => "/pkg/templates"),
    // Templates-root guard (#822). Defaults to "present" so the existing suite
    // exercises the paths past the guard; the guard's own failure branch is
    // covered by its dedicated test below.
    assertTemplatesDirExists: vi.fn(async () => "/pkg/templates"),
    isCustomizableFile: (localPath: string): boolean =>
      [".claude/memory/constitution.md"].includes(
        localPath.replace(/\\/g, "/"),
      ),
    previewScriptsSymlinkTargets: vi.fn(() => Promise.resolve([])),
  };
});

// Mock config
vi.mock("../lib/config.js", () => ({
  getConfig: vi.fn(),
}));

// Mock the opencode shim refresh (#1030). Defaults to "none" so the existing
// suite's blanket `mockFileExists.mockResolvedValue(true)` doesn't make every
// test think a shim is present and try to really refresh it — tests that care
// about the shim override this explicitly.
vi.mock("./init.js", () => ({
  decideOpencodeShimSync: vi.fn(async () => "none" as const),
  refreshOpencodeShim: vi.fn(),
}));

// Mock the MCP pin (#793). `syncSequantMcpPin` reads and writes `.mcp.json`
// through node's `fs` directly, so it bypasses the `../lib/fs.js` mock above.
// These tests never chdir, which means an unmocked call resolves
// `process.cwd()` to the sequant repo itself and rewrites the real tracked
// `.mcp.json`. Verified: without this mock, `vitest run src/commands/sync.test.ts`
// leaves ` M .mcp.json` behind.
vi.mock("../lib/mcp-config.js", () => ({
  syncSequantMcpPin: vi.fn(() => ({ updated: false, reason: "no-file" })),
}));

import {
  getSkillsVersion,
  areSkillsOutdated,
  checkAndWarnSkillsOutdated,
  syncCommand,
} from "./sync.js";
import { fileExists, readFile, writeFile, getFileStats } from "../lib/fs.js";
import { getManifest, getPackageVersion } from "../lib/manifest.js";
import {
  copyTemplates,
  computeTemplateChanges,
  listTemplateFiles,
  previewScriptsSymlinkTargets,
} from "../lib/templates.js";
import { getConfig } from "../lib/config.js";
import { syncSequantMcpPin } from "../lib/mcp-config.js";
import { generateAgentsMd } from "../lib/agents-md.js";
import { decideOpencodeShimSync, refreshOpencodeShim } from "./init.js";

const mockDecideOpencodeShimSync = vi.mocked(decideOpencodeShimSync);
const mockRefreshOpencodeShim = vi.mocked(refreshOpencodeShim);

const mockSyncMcpPin = vi.mocked(syncSequantMcpPin);
const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockGetFileStats = vi.mocked(getFileStats);
const mockGetManifest = vi.mocked(getManifest);
const mockGetPackageVersion = vi.mocked(getPackageVersion);
const mockCopyTemplates = vi.mocked(copyTemplates);
const mockComputeTemplateChanges = vi.mocked(computeTemplateChanges);
const mockListTemplateFiles = vi.mocked(listTemplateFiles);
const mockPreviewScriptsSymlinkTargets = vi.mocked(
  previewScriptsSymlinkTargets,
);
const mockGetConfig = vi.mocked(getConfig);

describe("sync command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // resetAllMocks strips the factory implementation, so restore a valid
    // SyncMcpPinResult — sync.ts reads `.updated` off the return value.
    mockSyncMcpPin.mockReturnValue({ updated: false, reason: "no-file" });
  });

  afterEach(() => {
    // Some paths (missing manifest, content drift) set a non-zero exit code;
    // reset so it never leaks across tests or into the vitest process.
    process.exitCode = 0;
  });

  describe("getSkillsVersion", () => {
    it("returns null when version file does not exist", async () => {
      mockFileExists.mockResolvedValue(false);

      const version = await getSkillsVersion();

      expect(version).toBeNull();
    });

    it("returns version from file when it exists", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0\n");

      const version = await getSkillsVersion();

      expect(version).toBe("1.0.0");
    });
  });

  describe("areSkillsOutdated", () => {
    it("returns outdated true when versions differ", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(true);
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.packageVersion).toBe("1.1.0");
    });

    it("returns outdated false when versions match", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
    });

    it("returns outdated true when version file missing", async () => {
      mockFileExists.mockResolvedValue(false);
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(true);
      expect(result.currentVersion).toBeNull();
    });

    it("reports contentDrift on a version match with new/modified files (AC-1)", async () => {
      // Version marker matches but bundled content has drifted in place — the
      // #708 blind spot. The pre-flight must now see it.
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "modified",
          rendered: "new",
          diff: "diff",
        },
        {
          path: ".claude/skills/new/SKILL.md",
          templatePath: "templates/skills/new/SKILL.md",
          status: "new",
          rendered: "new",
        },
      ]);

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
      expect(result.contentDrift).toBe(2);
    });

    it("excludes local-override/unchanged from contentDrift (AC-1, #711)", async () => {
      // A customized constitution (local-override) or identical file (unchanged)
      // must NOT register as drift — otherwise every command would warn.
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/memory/constitution.md",
          templatePath: "templates/memory/constitution.md",
          status: "local-override",
          rendered: "template",
        },
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "unchanged",
          rendered: "same",
        },
      ]);

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
      expect(result.contentDrift).toBe(0);
    });

    it("skips the content diff on a version mismatch (AC-5 fast-path)", async () => {
      // A version mismatch already means stale; the copy path handles it, so the
      // per-command pre-flight must NOT pay for a template scan.
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(true);
      expect(result.contentDrift).toBe(0);
      expect(mockComputeTemplateChanges).not.toHaveBeenCalled();
    });

    it("treats a content-diff failure as no drift (pre-flight never throws)", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockRejectedValue(new Error("read error"));

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
      expect(result.contentDrift).toBe(0);
    });
  });

  describe("areSkillsOutdated content-drift cache (AC-5)", () => {
    const VERSION_PATH = ".claude/skills/.sequant-version";
    const CACHE_PATH = ".claude/.sequant/.skills-drift-cache.json";

    const fakeStat = (mtimeMs: number) =>
      ({ mtimeMs }) as unknown as Awaited<ReturnType<typeof getFileStats>>;

    // Wire fs mocks so the drift cache round-trips through an in-memory store,
    // letting one run's write be the next run's read. `null` = cache absent.
    function setup(mtimeMs: number) {
      const store: { value: string | null } = { value: null };
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockGetConfig.mockResolvedValue(null);
      mockListTemplateFiles.mockResolvedValue([]);
      mockGetFileStats.mockResolvedValue(fakeStat(mtimeMs));
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/a/SKILL.md",
          templatePath: "templates/skills/a/SKILL.md",
          status: "modified",
          rendered: "x",
          diff: "d",
        },
      ]);
      mockFileExists.mockImplementation(async (p: string) => {
        if (p === VERSION_PATH) return true;
        if (p === CACHE_PATH) return store.value !== null;
        return false;
      });
      mockReadFile.mockImplementation(async (p: string) => {
        if (p === VERSION_PATH) return "1.1.0";
        if (p === CACHE_PATH) return store.value ?? "";
        return "";
      });
      mockWriteFile.mockImplementation(async (p: string, content: string) => {
        if (p === CACHE_PATH) store.value = content;
      });
      return store;
    }

    it("default (no cache) never reads or writes the cache and always scans", async () => {
      setup(1000);

      const result = await areSkillsOutdated();

      expect(result.contentDrift).toBe(1);
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);
      // No fingerprint stats, no cache file write on the uncached default path.
      expect(mockGetFileStats).not.toHaveBeenCalled();
      expect(mockListTemplateFiles).not.toHaveBeenCalled();
      const cacheWrites = mockWriteFile.mock.calls.filter(
        (c) => c[0] === CACHE_PATH,
      );
      expect(cacheWrites).toHaveLength(0);
    });

    it("scans once, then serves the cached result while nothing changes", async () => {
      const store = setup(1000);

      const first = await areSkillsOutdated({ cache: true });
      expect(first.contentDrift).toBe(1);
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);
      expect(store.value).not.toBeNull(); // cache was populated

      mockComputeTemplateChanges.mockClear();
      const second = await areSkillsOutdated({ cache: true });

      expect(second.contentDrift).toBe(1);
      // Same fingerprint → full scan skipped entirely.
      expect(mockComputeTemplateChanges).not.toHaveBeenCalled();
    });

    it("rescans (no stale warning) when a tracked file's mtime changes", async () => {
      setup(1000);
      await areSkillsOutdated({ cache: true });
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);

      // A file was edited in place → its mtime moves → fingerprint differs.
      mockGetFileStats.mockResolvedValue(fakeStat(2000));
      mockComputeTemplateChanges.mockClear();

      const result = await areSkillsOutdated({ cache: true });

      expect(result.contentDrift).toBe(1);
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);
    });

    it("falls back to a fresh scan when the fingerprint can't be computed", async () => {
      const store = setup(1000);
      mockListTemplateFiles.mockRejectedValue(new Error("walk failed"));

      const result = await areSkillsOutdated({ cache: true });

      expect(result.contentDrift).toBe(1);
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);
      // Fingerprint null → nothing cached.
      expect(store.value).toBeNull();
    });
  });

  describe("checkAndWarnSkillsOutdated", () => {
    it("warns and returns true on a version mismatch", async () => {
      const logSpy = vi.spyOn(console, "log");

      const warned = await checkAndWarnSkillsOutdated({
        outdated: true,
        currentVersion: "1.0.0",
        packageVersion: "1.1.0",
        contentDrift: 0,
      });

      expect(warned).toBe(true);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("Skills are outdated");
    });

    it("warns (warn-only) on content drift at a matching version (AC-2)", async () => {
      const logSpy = vi.spyOn(console, "log");

      const warned = await checkAndWarnSkillsOutdated({
        outdated: false,
        currentVersion: "1.1.0",
        packageVersion: "1.1.0",
        contentDrift: 3,
      });

      expect(warned).toBe(true);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("3 file(s) differ");
      // Remediation points at the commands that actually fix in-place drift —
      // a bare `sync` at a matching version is report-only (#708).
      expect(output).toContain("sync --force");
      // Pre-flight must not fail the command it precedes.
      expect(process.exitCode).toBe(0);
    });

    it("returns false and stays silent when up to date", async () => {
      const logSpy = vi.spyOn(console, "log");

      const warned = await checkAndWarnSkillsOutdated({
        outdated: false,
        currentVersion: "1.1.0",
        packageVersion: "1.1.0",
        contentDrift: 0,
      });

      expect(warned).toBe(false);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("syncCommand", () => {
    it("fails when manifest does not exist", async () => {
      mockGetManifest.mockResolvedValue(null);

      await syncCommand();

      expect(process.exitCode).toBe(1);
    });

    it("skips sync when versions match and content is identical", async () => {
      // AC-2: truthful no-op only when content is actually identical
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      // No drift: every template renders identical to installed content
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "unchanged",
          rendered: "x",
        },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await syncCommand();

      expect(mockCopyTemplates).not.toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some((c) =>
          String(c[0]).includes("already up to date"),
        ),
      ).toBe(true);
    });

    it("re-pins .mcp.json even on the up-to-date fast path (#793)", async () => {
      // The pin must run BEFORE the "already up to date" early return. A
      // version-only upgrade leaves every template byte-identical, so this
      // fast path is exactly the case where the pin most needs refreshing —
      // and it was the case `update` handled but `sync` silently skipped.
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "unchanged",
          rendered: "x",
        },
      ]);
      mockSyncMcpPin.mockReturnValue({
        updated: true,
        from: "sequant@latest",
        to: "sequant@1.1.0",
      });

      const logSpy = vi.spyOn(console, "log");
      await syncCommand();

      expect(mockSyncMcpPin).toHaveBeenCalledTimes(1);
      expect(
        logSpy.mock.calls.some((c) => String(c[0]).includes("MCP pin")),
      ).toBe(true);
    });

    it("passes dryRun through to the .mcp.json pin so a preview never writes (#793)", async () => {
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([]);

      await syncCommand({ dryRun: true });

      expect(mockSyncMcpPin).toHaveBeenCalledWith(expect.any(String), {
        dryRun: true,
      });
    });

    it("reports drift instead of false up-to-date when content differs at equal version", async () => {
      // AC-1: version marker matches but content differs
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "modified",
          rendered: "new",
          diff: "diff",
        },
        {
          path: ".claude/skills/new/SKILL.md",
          templatePath: "templates/skills/new/SKILL.md",
          status: "new",
          rendered: "new",
        },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await syncCommand();

      // Report-only: does not mutate, does not claim up to date
      expect(mockCopyTemplates).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).not.toContain("already up to date");
      expect(output).toContain("2 file(s) differ");
      expect(output).toContain("sync --force");
      // Non-interactive / CI path must detect drift via the exit code.
      expect(process.exitCode).toBe(1);
    });

    it("signals drift via non-zero exit code even with --quiet (no silent success)", async () => {
      // AC-1 intent: the non-interactive path must not declare success on drift.
      // --quiet suppresses the message, but the exit code (the machine signal
      // automation actually checks) must still flag the drifted tree (#708).
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "modified",
          rendered: "new",
          diff: "diff",
        },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await syncCommand({ quiet: true });

      expect(mockCopyTemplates).not.toHaveBeenCalled();
      // Quiet suppresses the human-readable message...
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).not.toContain("already up to date");
      expect(output).not.toContain("file(s) differ");
      // ...but the exit code still signals drift to automation.
      expect(process.exitCode).toBe(1);
    });

    it("treats local-override drift as no-op (not reported as drift)", async () => {
      // A customized constitution at equal version should not trigger the
      // drift message — only new/modified count as actionable drift.
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/memory/constitution.md",
          templatePath: "templates/memory/constitution.md",
          status: "local-override",
          rendered: "template",
        },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await syncCommand();

      expect(mockCopyTemplates).not.toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some((c) =>
          String(c[0]).includes("already up to date"),
        ),
      ).toBe(true);
    });

    it("syncs when versions differ", async () => {
      mockGetManifest.mockResolvedValue({
        version: "1.0.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockCopyTemplates.mockResolvedValue({
        scriptsSymlinked: false,
        preservedCustomizable: [],
      });

      await syncCommand({ quiet: true });

      // Plain sync refreshes the trees (force:true) but does NOT opt into
      // overwriting user-owned customizable files (#814).
      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "nextjs",
        {},
        {
          force: true,
          overwriteCustomizable: false,
        },
      );
      expect(mockWriteFile).toHaveBeenCalled();
    });

    // #722: `sync` previously had no preview surface — on a version mismatch it
    // force-rewrote the whole tree silently, so an operator/CI had no trustworthy
    // way to see pending work before applying. `--dry-run` reuses the same
    // `computeTemplateChanges` source of truth the apply consults, so the preview
    // can never under-report the write-set.
    describe("--dry-run (#722)", () => {
      it("previews the write-set on a version mismatch without mutating (AC-1)", async () => {
        mockGetManifest.mockResolvedValue({
          version: "1.0.0",
          stack: "nextjs",
          installedAt: "2024-01-01",
          files: {},
        });
        mockFileExists.mockResolvedValue(true);
        mockReadFile.mockResolvedValue("1.0.0"); // marker < package → mismatch
        mockGetPackageVersion.mockReturnValue("1.1.0");
        mockGetConfig.mockResolvedValue(null);
        mockComputeTemplateChanges.mockResolvedValue([
          {
            path: ".claude/skills/qa/SKILL.md",
            templatePath: "templates/skills/qa/SKILL.md",
            status: "modified",
            rendered: "new",
            diff: "diff",
          },
          {
            path: ".claude/skills/new/SKILL.md",
            templatePath: "templates/skills/new/SKILL.md",
            status: "new",
            rendered: "new",
          },
        ]);

        const logSpy = vi.spyOn(console, "log");
        await syncCommand({ dryRun: true });

        const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        // Reports the real write-set, not a false "0 modified" / "up to date".
        expect(output).toContain("Modified: 1");
        expect(output).toContain("New files: 1");
        expect(output).toContain(".claude/skills/qa/SKILL.md");
        expect(output).not.toContain("already up to date");
        // Mutates nothing: no copy, no version-marker/manifest writes.
        expect(mockCopyTemplates).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
        // Pending work → non-zero exit so the preview can gate CI.
        expect(process.exitCode).toBe(1);
      });

      it("previews both the AGENTS.md decision and scripts/dev link changes, writing nothing (AC-6)", async () => {
        mockGetManifest.mockResolvedValue({
          version: "1.0.0",
          stack: "nextjs",
          installedAt: "2024-01-01",
          files: {},
        });
        const files: Record<string, string> = {
          ".claude/skills/.sequant-version": "1.0.0",
          "AGENTS.md": "# AGENTS.md\n\nHand-written.\n",
        };
        mockFileExists.mockImplementation(async (p: string) => p in files);
        mockReadFile.mockImplementation(async (p: string) => {
          if (p in files) return files[p];
          throw new Error(`unexpected read: ${p}`);
        });
        mockGetPackageVersion.mockReturnValue("1.1.0");
        mockGetConfig.mockResolvedValue(null);
        mockComputeTemplateChanges.mockResolvedValue([]);
        mockPreviewScriptsSymlinkTargets.mockResolvedValue([
          {
            path: "scripts/dev/new-feature.sh",
            oldTarget:
              "../../../../.npm/_npx/abc/node_modules/sequant/templates/scripts/new-feature.sh",
            newTarget:
              "../../node_modules/sequant/templates/scripts/new-feature.sh",
            changed: true,
          },
        ]);

        const logSpy = vi.spyOn(console, "log");
        await syncCommand({ dryRun: true });

        const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(output).toContain("AGENTS.md: preserved");
        expect(output).toContain("scripts/dev/new-feature.sh");
        expect(output).toContain(
          "../../node_modules/sequant/templates/scripts/new-feature.sh",
        );
        // Preview only: nothing written.
        expect(mockCopyTemplates).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
      });

      it("reports a customizable file as preserved, not written, under a plain dry-run (#814 AC-4)", async () => {
        // Since #814 the apply path PRESERVES CUSTOMIZABLE_FILES under a plain
        // sync, so the preview must show them as preserved — not "will be
        // overwritten" — and must not count them as pending write-set work.
        mockGetManifest.mockResolvedValue({
          version: "1.0.0",
          stack: "nextjs",
          installedAt: "2024-01-01",
          files: {},
        });
        mockFileExists.mockResolvedValue(true);
        mockReadFile.mockResolvedValue("1.0.0");
        mockGetPackageVersion.mockReturnValue("1.1.0");
        mockGetConfig.mockResolvedValue(null);
        mockComputeTemplateChanges.mockResolvedValue([
          {
            path: ".claude/memory/constitution.md",
            templatePath: "templates/memory/constitution.md",
            status: "local-override",
            rendered: "template",
          },
        ]);

        const logSpy = vi.spyOn(console, "log");
        await syncCommand({ dryRun: true });

        const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(output).toContain("Customizable (preserved): 1");
        expect(output).toContain("sync --force");
        expect(output).toContain(".claude/memory/constitution.md");
        expect(output).not.toContain("will be overwritten");
        expect(mockCopyTemplates).not.toHaveBeenCalled();
        // Nothing else drifts and the customizable file is preserved → no work.
        expect(process.exitCode).toBe(0);
      });

      it("previews a customizable file as overwritten under --force (#814 AC-3)", async () => {
        // With an explicit --force the customizable file IS part of the
        // write-set; the preview mirrors the apply and gates CI with exit 1.
        mockGetManifest.mockResolvedValue({
          version: "1.1.0",
          stack: "nextjs",
          installedAt: "2024-01-01",
          files: {},
        });
        mockFileExists.mockResolvedValue(true);
        mockReadFile.mockResolvedValue("1.1.0");
        mockGetPackageVersion.mockReturnValue("1.1.0");
        mockGetConfig.mockResolvedValue(null);
        mockComputeTemplateChanges.mockResolvedValue([
          {
            path: ".claude/memory/constitution.md",
            templatePath: "templates/memory/constitution.md",
            status: "local-override",
            rendered: "template",
          },
        ]);

        const logSpy = vi.spyOn(console, "log");
        await syncCommand({ dryRun: true, force: true });

        const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(output).toContain("Local overrides (overwritten): 1");
        expect(output).toContain("will be overwritten");
        expect(output).not.toContain("(preserved)");
        expect(mockCopyTemplates).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      });

      it("previews under --force at a matching version without mutating (AC-1)", async () => {
        mockGetManifest.mockResolvedValue({
          version: "1.1.0",
          stack: "nextjs",
          installedAt: "2024-01-01",
          files: {},
        });
        mockFileExists.mockResolvedValue(true);
        mockReadFile.mockResolvedValue("1.1.0"); // versions match
        mockGetPackageVersion.mockReturnValue("1.1.0");
        mockGetConfig.mockResolvedValue(null);
        mockComputeTemplateChanges.mockResolvedValue([
          {
            path: ".claude/skills/qa/SKILL.md",
            templatePath: "templates/skills/qa/SKILL.md",
            status: "modified",
            rendered: "new",
            diff: "diff",
          },
        ]);

        const logSpy = vi.spyOn(console, "log");
        await syncCommand({ dryRun: true, force: true });

        const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(output).toContain("Modified: 1");
        expect(mockCopyTemplates).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      });

      it("reports up to date and exits 0 when there is nothing to write", async () => {
        mockGetManifest.mockResolvedValue({
          version: "1.1.0",
          stack: "nextjs",
          installedAt: "2024-01-01",
          files: {},
        });
        mockFileExists.mockResolvedValue(true);
        mockReadFile.mockResolvedValue("1.1.0");
        mockGetPackageVersion.mockReturnValue("1.1.0");
        mockGetConfig.mockResolvedValue(null);
        mockComputeTemplateChanges.mockResolvedValue([
          {
            path: ".claude/skills/qa/SKILL.md",
            templatePath: "templates/skills/qa/SKILL.md",
            status: "unchanged",
            rendered: "same",
          },
        ]);

        const logSpy = vi.spyOn(console, "log");
        // --force reaches the dry-run preview even at a matching version.
        await syncCommand({ dryRun: true, force: true });

        const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(output).toContain("already up to date");
        expect(mockCopyTemplates).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(0);
      });
    });

    it("syncs when force is set even if versions match", async () => {
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([]);
      mockCopyTemplates.mockResolvedValue({
        scriptsSymlinked: false,
        preservedCustomizable: [],
      });

      await syncCommand({ force: true, quiet: true });

      // --force opts into overwriting user-owned customizable files (#814).
      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "nextjs",
        {},
        {
          force: true,
          overwriteCustomizable: true,
        },
      );
    });

    it("announces customizable overwrites on stdout before copying under --force (#814 AC-3)", async () => {
      // AC-3: an explicit --force still overwrites CUSTOMIZABLE_FILES, but must
      // say so on stdout *before* the copy runs — no silent clobber.
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/memory/constitution.md",
          templatePath: "templates/memory/constitution.md",
          status: "local-override",
          rendered: "template",
        },
      ]);

      const announceOrder: string[] = [];
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation((msg?: unknown) => {
          announceOrder.push(String(msg));
        });
      mockCopyTemplates.mockImplementation(async () => {
        announceOrder.push("<<copyTemplates>>");
        return { scriptsSymlinked: false, preservedCustomizable: [] };
      });

      await syncCommand({ force: true });

      const output = announceOrder.join("\n");
      expect(output).toContain("Overwriting 1 customizable file(s) (--force)");
      expect(output).toContain(".claude/memory/constitution.md");
      // The announcement precedes the actual copy.
      const announceIdx = announceOrder.findIndex((l) =>
        l.includes("Overwriting 1 customizable file(s)"),
      );
      const copyIdx = announceOrder.indexOf("<<copyTemplates>>");
      expect(announceIdx).toBeGreaterThanOrEqual(0);
      expect(copyIdx).toBeGreaterThan(announceIdx);
      logSpy.mockRestore();
    });

    it("reports preserved customizable files on stdout under a plain sync (#814 AC-4)", async () => {
      // AC-4: plain sync preserves CUSTOMIZABLE_FILES and reports each one, so
      // the apply path's output matches the --dry-run promise (#722).
      mockGetManifest.mockResolvedValue({
        version: "1.0.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0"); // marker < package → apply path
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockCopyTemplates.mockResolvedValue({
        scriptsSymlinked: false,
        preservedCustomizable: [".claude/memory/constitution.md"],
      });

      const logSpy = vi.spyOn(console, "log");
      await syncCommand();

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain(
        "preserved: .claude/memory/constitution.md — run `sync --force` to replace",
      );
      // Plain sync must NOT opt into overwriting user-owned files.
      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "nextjs",
        {},
        {
          force: true,
          overwriteCustomizable: false,
        },
      );
    });

    describe("AGENTS.md ownership (AC-2, AC-3)", () => {
      const SKILLS_VERSION_PATH = ".claude/skills/.sequant-version";

      function mockFilesByPath(map: Record<string, string>) {
        mockFileExists.mockImplementation(async (p: string) => p in map);
        mockReadFile.mockImplementation(async (p: string) => {
          if (p in map) return map[p];
          throw new Error(`unexpected read: ${p}`);
        });
      }

      beforeEach(() => {
        mockGetManifest.mockResolvedValue({
          version: "1.1.0",
          stack: "generic",
          installedAt: "2024-01-01",
          files: {},
        });
        mockGetPackageVersion.mockReturnValue("1.1.0");
        mockGetConfig.mockResolvedValue(null);
        mockCopyTemplates.mockResolvedValue({
          scriptsSymlinked: false,
          preservedCustomizable: [],
        });
      });

      it("leaves an unmarked AGENTS.md byte-identical and reports it preserved", async () => {
        mockFilesByPath({
          [SKILLS_VERSION_PATH]: "1.0.0", // mismatch → apply path
          "AGENTS.md": "# AGENTS.md\n\nHand-written by a human.\n",
        });

        const logSpy = vi.spyOn(console, "log");
        await syncCommand();

        expect(mockWriteFile.mock.calls.some((c) => c[0] === "AGENTS.md")).toBe(
          false,
        );
        const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(output).toContain("preserved: AGENTS.md — user-owned");
      });

      it("regenerates a marked AGENTS.md whose hash matches the body", async () => {
        const owned = await generateAgentsMd({
          projectName: "p",
          stack: "generic",
        });
        mockFilesByPath({
          [SKILLS_VERSION_PATH]: "1.0.0",
          "AGENTS.md": owned,
        });

        await syncCommand({ quiet: true });

        expect(mockWriteFile.mock.calls.some((c) => c[0] === "AGENTS.md")).toBe(
          true,
        );
      });

      it("--force rewrites an unmarked AGENTS.md too", async () => {
        mockFilesByPath({
          [SKILLS_VERSION_PATH]: "1.1.0", // matches package; only --force applies
          "AGENTS.md": "# AGENTS.md\n\nHand-written.\n",
        });

        await syncCommand({ force: true, quiet: true });

        expect(mockWriteFile.mock.calls.some((c) => c[0] === "AGENTS.md")).toBe(
          true,
        );
      });

      it("--no-agents-md skips generation entirely and leaves the file untouched (AC-3)", async () => {
        mockFilesByPath({
          [SKILLS_VERSION_PATH]: "1.0.0",
          "AGENTS.md": "# AGENTS.md\n\nHand-written.\n",
        });

        await syncCommand({ agentsMd: false, quiet: true });

        expect(mockWriteFile.mock.calls.some((c) => c[0] === "AGENTS.md")).toBe(
          false,
        );
      });
    });

    // #1030 AC-1/AC-3: the opencode shim has one producer (init.ts's writers,
    // reached via decideOpencodeShimSync/refreshOpencodeShim), and what
    // --dry-run previews must match what the apply path actually does.
    describe("opencode shim (AC-1, AC-3)", () => {
      beforeEach(() => {
        mockGetManifest.mockResolvedValue({
          version: "1.1.0",
          stack: "generic",
          installedAt: "2024-01-01",
          files: {},
        });
        mockGetPackageVersion.mockReturnValue("1.1.0");
        mockGetConfig.mockResolvedValue(null);
        mockFileExists.mockResolvedValue(true);
        mockReadFile.mockResolvedValue("1.0.0"); // version mismatch → apply path
        mockComputeTemplateChanges.mockResolvedValue([]);
        mockCopyTemplates.mockResolvedValue({
          scriptsSymlinked: false,
          preservedCustomizable: [],
        });
      });

      it("dry-run matches apply: previews 'refresh' and apply actually refreshes it, on a project with .opencode/", async () => {
        mockDecideOpencodeShimSync.mockResolvedValue("refresh");

        const logSpy = vi.spyOn(console, "log");
        await syncCommand({ dryRun: true });
        const dryRunOutput = logSpy.mock.calls
          .map((c) => String(c[0]))
          .join("\n");
        expect(dryRunOutput).toContain("opencode shim: refresh");
        expect(mockRefreshOpencodeShim).not.toHaveBeenCalled();

        await syncCommand();
        expect(mockRefreshOpencodeShim).toHaveBeenCalledTimes(1);
      });

      it("treats a shim that already matches ('current') as nothing to do: exit 0, no refresh", async () => {
        // Second-pass QA on #1030: a presence-based decision made every
        // opencode project permanently pending. 'current' must read like
        // 'none' for the exit code and the apply path, while still being
        // visible in the preview.
        mockDecideOpencodeShimSync.mockResolvedValue("current");
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
          const logSpy = vi.spyOn(console, "log");
          await syncCommand({ dryRun: true });
          const dryRunOutput = logSpy.mock.calls
            .map((c) => String(c[0]))
            .join("\n");
          expect(dryRunOutput).toContain("opencode shim: current");
          expect(dryRunOutput).toContain("already up to date");
          expect(process.exitCode).not.toBe(1);

          await syncCommand();
          expect(mockRefreshOpencodeShim).not.toHaveBeenCalled();
        } finally {
          process.exitCode = prevExitCode;
          mockDecideOpencodeShimSync.mockResolvedValue("none");
        }
      });

      it("never refreshes or previews anything on a project without .opencode/", async () => {
        mockDecideOpencodeShimSync.mockResolvedValue("none");

        const logSpy = vi.spyOn(console, "log");
        await syncCommand({ dryRun: true });
        const dryRunOutput = logSpy.mock.calls
          .map((c) => String(c[0]))
          .join("\n");
        expect(dryRunOutput).not.toContain("opencode shim");

        await syncCommand();
        expect(mockRefreshOpencodeShim).not.toHaveBeenCalled();
      });
    });
  });
});
