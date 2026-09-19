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

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = join(__dirname, "mcp-launch.mjs");

const IMPORT_BLOCK = `import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";`;

const REQUIRE_BLOCK = `const { spawn } = require("node:child_process");
const {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
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

  // `node -e` runs CommonJS: every `export function` becomes a plain
  // function. Anything else exported (const, default, re-exports) is a shape
  // this generator does not know how to inline, so refuse rather than ship it.
  src = src.replace(/^export function /gm, "function ");
  if (/^export\b/m.test(src)) {
    throw new Error(
      "generate-mcp-launch-inline: mcp-launch.mjs exports something other than `export function`; update this generator",
    );
  }

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
  src = src.replaceAll("process.argv[2]", "process.argv[1]");

  return src.trim();
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const source = generateInlineLauncherSource();
  if (process.argv.includes("--write")) {
    // Rewrite the shipped .mcp.json's inline launcher (args[1]) in place.
    // `npm run mcp-launch:inline` — also the first step of prepare:marketplace,
    // so a release can never ship a launcher that drifted from mcp-launch.mjs.
    const mcpJsonPath = join(__dirname, "..", ".mcp.json");
    const config = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    const entry = config.mcpServers?.sequant;
    if (!entry || entry.command !== "node" || entry.args?.[0] !== "-e") {
      throw new Error(
        "generate-mcp-launch-inline: .mcp.json mcpServers.sequant is not the inline `node -e` shape",
      );
    }
    if (entry.args[1] === source) {
      process.stderr.write("mcp-launch:inline: .mcp.json already up to date\n");
    } else {
      entry.args[1] = source;
      writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n");
      process.stderr.write("mcp-launch:inline: rewrote .mcp.json args[1]\n");
    }
  } else {
    process.stdout.write(source + "\n");
  }
}
