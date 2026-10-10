/**
 * #1387 AC-2: init's next steps name the commit step and `sequant run`.
 */

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildNextSteps, resolveCommitPaths } from "./init.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("buildNextSteps (#1387)", () => {
  describe("AC-2: next steps include commit and run", () => {
    it("includes a commit step naming .claude/skills/ before `sequant run <issue>`", () => {
      const steps = stripAnsi(buildNextSteps());
      const commit = steps.indexOf("git commit");
      const run = steps.indexOf("npx sequant run");
      expect(steps).toContain(".claude/");
      expect(commit).toBeGreaterThan(-1);
      expect(run).toBeGreaterThan(commit);
    });

    describe("error handling", () => {
      it("keeps the existing /spec, /exec, /qa and constitution steps", () => {
        const steps = stripAnsi(buildNextSteps());
        expect(steps).toContain(".claude/memory/constitution.md");
        for (const cmd of ["/spec 123", "/exec 123", "/qa 123"]) {
          expect(steps).toContain(cmd);
        }
      });

      it("uses the npx-style invocation consistent with the README", () => {
        expect(stripAnsi(buildNextSteps())).toMatch(/npx sequant run \d+/);
      });
    });
  });

  describe("AC-2: the printed git add command works on what init wrote", () => {
    it("stages the generated files without naming gitignored .sequant/ or a skipped AGENTS.md", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sequant-next-steps-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, ".claude/skills/spec"), { recursive: true });
        writeFileSync(join(dir, ".claude/skills/spec/SKILL.md"), "spec\n");
        mkdirSync(join(dir, ".sequant/logs"), { recursive: true });
        writeFileSync(join(dir, ".sequant/logs/run.json"), "{}\n");
        writeFileSync(join(dir, ".sequant-manifest.json"), "{}\n");
        writeFileSync(join(dir, ".gitignore"), "node_modules/\n.sequant/\n");
        // No AGENTS.md: init ran with --no-agents-md.

        const steps = stripAnsi(buildNextSteps(await resolveCommitPaths(dir)));
        const addLine = steps
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("git add "));
        expect(addLine).toBeDefined();
        const args = addLine!.split(/\s+/).slice(1);
        expect(args).not.toContain(".sequant/");
        expect(args).not.toContain("AGENTS.md");

        execFileSync("git", args, { cwd: dir, stdio: "pipe" });
        const staged = execFileSync(
          "git",
          ["diff", "--cached", "--name-only"],
          {
            cwd: dir,
            encoding: "utf8",
          },
        )
          .trim()
          .split("\n");
        expect(staged).toEqual(
          expect.arrayContaining([
            ".claude/skills/spec/SKILL.md",
            ".gitignore",
            ".sequant-manifest.json",
          ]),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
