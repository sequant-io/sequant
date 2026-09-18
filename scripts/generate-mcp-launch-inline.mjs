#!/usr/bin/env node
// #1084 AC-2: turns the tested `scripts/mcp-launch.mjs` into the inline
// `node -e <source>` form shipped in `.mcp.json`. A file-path launcher
// requires `${CLAUDE_PLUGIN_ROOT}` (or a `:-default`, which resolves to the
// open project, not the plugin root — see the QA probe on #1084) to locate
// it; inlining the source removes the placeholder entirely. Keeping
// mcp-launch.mjs as the source of truth means its existing unit and
// integration tests still cover the real launcher logic — this generator
// only reshapes it for `node -e`, which runs CommonJS by default (no
// `import`/`export`, no `import.meta`) and never sets argv[0] to a script
// path (so the pinned spec lands at argv[1], not argv[2]).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = join(__dirname, "mcp-launch.mjs");

const IMPORT_BLOCK = `import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";`;

const REQUIRE_BLOCK = `const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");`;

const MAIN_GUARD_BLOCK = `// Only run when invoked directly (\`node mcp-launch.mjs ...\`), not when
// imported — lets tests exercise resolveNpxCommand() without triggering the
// spawn side effects above.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}`;

/**
 * Generate the inline `node -e` launcher source from `scripts/mcp-launch.mjs`.
 * Throws if the source file's shape has drifted from what this generator
 * knows how to transform, rather than silently shipping a broken launcher.
 */
export function generateInlineLauncherSource(sourcePath = DEFAULT_SOURCE) {
  let src = readFileSync(sourcePath, "utf8");

  src = src.replace(/^#!.*\n/, "");

  if (!src.includes(IMPORT_BLOCK)) {
    throw new Error(
      "generate-mcp-launch-inline: import block shape changed in mcp-launch.mjs; update this generator",
    );
  }
  src = src.replace(IMPORT_BLOCK, REQUIRE_BLOCK);

  if (!src.includes("export function resolveNpxCommand")) {
    throw new Error(
      "generate-mcp-launch-inline: resolveNpxCommand export shape changed in mcp-launch.mjs; update this generator",
    );
  }
  src = src.replace(
    "export function resolveNpxCommand",
    "function resolveNpxCommand",
  );

  if (!src.includes(MAIN_GUARD_BLOCK)) {
    throw new Error(
      "generate-mcp-launch-inline: isMain guard shape changed in mcp-launch.mjs; update this generator",
    );
  }
  src = src.replace(MAIN_GUARD_BLOCK, "main();");

  if (!src.includes("process.argv[2]")) {
    throw new Error(
      "generate-mcp-launch-inline: spec argv index changed in mcp-launch.mjs; update this generator",
    );
  }
  src = src.replace("process.argv[2]", "process.argv[1]");

  return src.trim();
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.stdout.write(generateInlineLauncherSource() + "\n");
}
