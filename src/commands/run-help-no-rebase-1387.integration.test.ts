/**
 * #1387 AC-5: `run --help` describes `--no-rebase` as skipping the rebase onto
 * the base branch, not onto a hardcoded origin/main.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const cliPath = resolve(projectRoot, "dist/bin/cli.js");

beforeAll(() => {
  if (!existsSync(cliPath)) {
    throw new Error(`dist/bin/cli.js not found. Run 'npm run build' first.`);
  }
});

/** The `--no-rebase` entry of `run --help`, joined across wrapped lines. */
function noRebaseHelp(): string {
  const result = spawnSync("node", [cliPath, "run", "--help"], {
    cwd: projectRoot,
    encoding: "utf-8",
    env: { ...process.env, COLUMNS: "400" },
  });
  const lines = result.stdout.split("\n");
  const start = lines.findIndex((l) => l.includes("--no-rebase"));
  if (start === -1) return "";
  const entry = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    // Option entries start at two spaces then a dash; continuation lines are indented deeper.
    if (/^ {0,3}\S/.test(l) || l.trim() === "") break;
    entry.push(l);
  }
  return entry.join(" ").replace(/\s+/g, " ");
}

describe("run --no-rebase help (#1387)", () => {
  describe("AC-5: description names the base branch", () => {
    it("describes --no-rebase as skipping the rebase onto the base branch, not origin/main", () => {
      const help = noRebaseHelp();
      expect(help).toContain("--no-rebase");
      expect(help).toMatch(/onto the base branch/);
      expect(help).toContain("--base");
      expect(help).not.toContain("origin/main");
    });

    it("registers the --no-rebase option at all (guards a vacuous pass)", () => {
      expect(noRebaseHelp()).not.toBe("");
    });
  });
});
