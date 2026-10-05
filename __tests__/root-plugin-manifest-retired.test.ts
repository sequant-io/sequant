/**
 * Gate for #1301 (AC-4): the root `.claude-plugin/plugin.json` is retired and
 * no reader in the repo's own tooling targets it again.
 *
 * `plugin/.claude-plugin/plugin.json` is the one manifest — the file
 * marketplace.json's `./plugin` source resolves to (#1265). A reader that
 * names the root path either fails (the file is gone) or, worse, a future
 * edit restores the root file and the two copies drift again (constitution
 * row #1250: one producer per artifact).
 *
 * Out of scope on purpose: `pre-tool.sh` resolves `.claude-plugin/plugin.json`
 * relative to the *installed plugin cache*, which is the shipped manifest.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { collectFiles, SKILL_ROOTS } from "../scripts/check-skill-sync.js";
import { checkVersionSync } from "../src/lib/plugin-version-sync.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** A repo-root manifest path: not preceded by `plugin/` or any path segment. */
const ROOT_MANIFEST_PATH = /(?<![\w/])\.claude-plugin\/plugin\.json/;
/** The same reader written as `join(<root>, ".claude-plugin", "plugin.json")`. */
const ROOT_MANIFEST_JOIN =
  /(?:PROJECT_ROOT|projectRoot),\s*"\.claude-plugin",\s*"plugin\.json"/;

const READERS = [
  ".github/workflows/ci.yml",
  ".github/workflows/plugin-install-test.yml",
  "scripts/release.sh",
  "scripts/prepare-marketplace.ts",
  "src/lib/plugin-version-sync.ts",
];

/**
 * Lines that name `.claude-plugin/plugin.json` relative to the *built
 * marketplace package* (dist/…/sequant/), not the repo root.
 */
const PACKAGE_RELATIVE_LINES = [
  'console.log("  ✅ .claude-plugin/plugin.json");',
  'console.error("  ❌ .claude-plugin/plugin.json (MISSING)");',
];

function rootManifestReaders(file: string): string[] {
  const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
  const hits = text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => ROOT_MANIFEST_PATH.test(line))
    .filter(({ line }) => !PACKAGE_RELATIVE_LINES.includes(line.trim()))
    .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
  if (ROOT_MANIFEST_JOIN.test(text)) hits.push(`${file}: join() root reader`);
  return hits;
}

function releaseSkillCopies(): string[] {
  return SKILL_ROOTS.flatMap((root) =>
    collectFiles(path.join(REPO_ROOT, root, "release"))
      .filter((rel) => rel === "SKILL.md")
      .map(() => path.join(root, "release", "SKILL.md")),
  );
}

describe("root plugin manifest retired (#1301)", () => {
  it("the root manifest is gone and version sync reads plugin/", () => {
    const result = checkVersionSync(REPO_ROOT);

    expect(
      fs.existsSync(path.join(REPO_ROOT, ".claude-plugin/plugin.json")),
    ).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.inSync).toBe(true);
  });

  it("no tooling reader targets the root manifest", () => {
    const skills = releaseSkillCopies();
    const hits = [...READERS, ...skills].flatMap(rootManifestReaders);

    expect(skills).toHaveLength(3);
    expect(hits).toEqual([]);
  });
});
