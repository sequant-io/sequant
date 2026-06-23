/**
 * Tests for the three-directory skill-sync checker (scripts/check-skill-sync.ts).
 *
 * Focus: the #738 hardening — collectFiles() skips dotfiles and dot-directories
 * so transient, git-ignored artifacts (e.g. .sequant/.token-usage-*.json) never
 * surface as false-positive "missing" entries, and the documented EXCLUDE
 * allowlist escape hatch is exported.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { collectFiles, EXCLUDE } from "./check-skill-sync";

describe("collectFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-sync-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("collects normal files, including nested ones", () => {
    writeFileSync(join(dir, "SKILL.md"), "x");
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "guide.md"), "y");

    const files = collectFiles(dir);

    expect(files).toContain("SKILL.md");
    expect(files).toContain("references/guide.md");
  });

  it("skips top-level dotfiles", () => {
    writeFileSync(join(dir, "SKILL.md"), "x");
    writeFileSync(join(dir, ".token-usage-123.json"), "{}");

    const files = collectFiles(dir);

    expect(files).toContain("SKILL.md");
    expect(files).not.toContain(".token-usage-123.json");
  });

  it("skips dot-directories and everything inside them", () => {
    writeFileSync(join(dir, "SKILL.md"), "x");
    mkdirSync(join(dir, ".sequant"));
    writeFileSync(join(dir, ".sequant", "state.json"), "{}");

    const files = collectFiles(dir);

    expect(files).toContain("SKILL.md");
    // The dot-dir is never descended into.
    expect(files.some((f) => f.includes(".sequant"))).toBe(false);
  });

  it("returns POSIX-style relative paths (forward slashes)", () => {
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "guide.md"), "y");

    const files = collectFiles(dir);

    expect(files).toContain("references/guide.md");
    expect(files.some((f) => f.includes("\\"))).toBe(false);
  });

  it("excludes files listed in the EXCLUDE allowlist", () => {
    // EXCLUDE is a Set; exercise the filtering contract with a temporary entry
    // so the test stays meaningful even while the shipped allowlist is empty.
    const mutable = EXCLUDE as Set<string>;
    writeFileSync(join(dir, "SKILL.md"), "x");
    writeFileSync(join(dir, "excluded.md"), "z");
    mutable.add("excluded.md");
    try {
      const files = collectFiles(dir);
      expect(files).toContain("SKILL.md");
      expect(files).not.toContain("excluded.md");
    } finally {
      mutable.delete("excluded.md");
    }
  });

  it("returns an empty list for a non-existent directory", () => {
    expect(collectFiles(join(dir, "does-not-exist"))).toEqual([]);
  });
});
