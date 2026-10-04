/**
 * CI gate for `/release`'s plugin-manifest preflight (issue #1135, AC-10).
 *
 * Claude Code 2.1.281 added MCP-server checks to `claude plugin validate`
 * (`.mcp.json` entries dropped at load, undeclared `${user_config.*}`,
 * insecure URLs). `/release` runs it in pre-flight and stops on error, so a
 * broken manifest never reaches npm or the marketplace.
 *
 * Two traps this pins:
 *  - `claude plugin validate .` validates only `.claude-plugin/marketplace.json`
 *    and skips `plugin.json`, so the step must name the plugin manifest.
 *  - "Stops on error" is a behavior, not a phrase: the Plugin Checks fence is
 *    executed against a stub `claude` that fails, and must exit non-zero.
 *
 * Assertions are scoped per CLAUDE.md § Testing to the `## Pre-flight Checks`
 * region (up to `## Release Steps`), in all three skill copies.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectFiles,
  SKILL_ROOTS,
} from "../../../scripts/check-skill-sync.js";

/** src/lib/__tests__ -> repo root (anchor to this file, not process.cwd()). */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";

/**
 * The release skill copy under `root`, found through `collectFiles` — the
 * walker `lint:skill-sync` uses — so a layout change moves this gate instead
 * of silently passing (precedent: release-skill-soak.test.ts).
 */
function releaseSkillPath(root: string): string {
  const base = path.join(REPO_ROOT, root);
  const found = collectFiles(base).find((rel) => rel === "release/SKILL.md");
  if (!found) throw new Error(`release/SKILL.md not found under ${root}`);
  return path.join(base, found);
}

/** The `## Pre-flight Checks` region, up to `## Release Steps`. */
function preflightSection(root: string): string {
  const full = fs.readFileSync(releaseSkillPath(root), "utf-8");
  const start = full.search(/^## Pre-flight Checks\s*$/m);
  const end = full.search(/^## Release Steps\s*$/m);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`${root}: pre-flight section bounds not found`);
  }
  const section = full.slice(start, end);
  if (section.length < 500) {
    throw new Error(
      `${root}: pre-flight section extracted as ${section.length} chars — extractor is broken`,
    );
  }
  return section;
}

/** The one bash fence in pre-flight that runs `claude plugin validate`. */
function validateBlock(root: string): string {
  const blocks = [
    ...preflightSection(root).matchAll(/```bash\n([\s\S]*?)```/g),
  ].map((m) => m[1]);
  const hits = blocks.filter((b) => /\bclaude plugin validate\b/.test(b));
  if (hits.length !== 1) {
    throw new Error(
      `${root}: expected exactly one pre-flight bash block running \`claude plugin validate\`, found ${hits.length}`,
    );
  }
  return hits[0];
}

let stubDir: string;
let callLog: string;

/**
 * Execute the skill's own fence with a stub `claude` first on PATH. The stub
 * records its argv and exits with STUB_EXIT.
 */
function runBlock(
  block: string,
  stubExit: number,
): { status: number | null; stdout: string; calls: string[] } {
  fs.writeFileSync(callLog, "");
  const r = spawnSync("bash", ["-c", block], {
    cwd: stubDir,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      STUB_EXIT: String(stubExit),
      STUB_LOG: callLog,
    },
    encoding: "utf8",
  });
  const calls = fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean);
  return { status: r.status, stdout: r.stdout, calls };
}

beforeAll(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-plugin-validate-"));
  callLog = path.join(stubDir, "calls.log");
  fs.writeFileSync(
    path.join(stubDir, "claude"),
    '#!/bin/sh\necho "$*" >> "$STUB_LOG"\nexit "$STUB_EXIT"\n',
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

for (const root of SKILL_ROOTS) {
  describe(`#1135/AC-10: /release pre-flight validates the plugin manifest [${root}]`, () => {
    it("names both manifests explicitly, not `.`", () => {
      const block = validateBlock(root);
      expect(block).toContain(`claude plugin validate ${PLUGIN_MANIFEST}`);
      expect(block).toContain(`claude plugin validate ${MARKETPLACE_MANIFEST}`);
      expect(block).not.toMatch(/claude plugin validate \.\s*(\|\||$)/m);
    });

    it("stops the release when validation fails", () => {
      const r = runBlock(validateBlock(root), 1);
      expect(r.status).not.toBe(0);
      // Stops AT the plugin manifest: nothing after it runs. Without this, a
      // swallowed plugin.json failure (`|| true`) would still exit non-zero
      // via the marketplace line and pass.
      expect(r.calls).toEqual([`plugin validate ${PLUGIN_MANIFEST}`]);
      expect(r.stdout).toContain(PLUGIN_MANIFEST);
    });

    it("proceeds when both manifests validate", () => {
      const r = runBlock(validateBlock(root), 0);
      expect(r.status).toBe(0);
      expect(r.calls).toEqual([
        `plugin validate ${PLUGIN_MANIFEST}`,
        `plugin validate ${MARKETPLACE_MANIFEST}`,
      ]);
    });
  });
}
