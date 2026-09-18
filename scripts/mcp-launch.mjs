#!/usr/bin/env node
// #1084: launcher shipped with the plugin so `npx` never resolves `sequant`
// from the open project's own node_modules (npx's local-project lookup keys
// off cwd, and no npx flag defeats it — only the working directory does).
// Runs before `npm install`, so this file must import only `node:` builtins.
//
// Usage: node mcp-launch.mjs <package-spec>
//   e.g. node mcp-launch.mjs <package-name>@<version>
//
// Note for maintainers: this file's comments must never spell out this
// package's own name immediately followed by "@" and a version number. The
// inline copy shipped in .mcp.json is generated verbatim from this file
// (scripts/generate-mcp-launch-inline.mjs), and the marketplace prep script
// stamps .mcp.json's args with a global find-and-replace of that exact
// pattern on release — an example version spelled out here would drift from
// that stamp and fail the byte-identical check in
// scripts/plugin-mcp-pin.test.ts on the next release.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// npm ships `npx` as `npx.cmd` on Windows. With `shell: false`, Node's spawn
// uses the OS's own exec (no PATHEXT resolution), so plain "npx" raises
// ENOENT there — a regression versus the previous shell-resolved `"command":
// "npx"` config Claude Code used to run. Naming the .cmd explicitly keeps
// shell: false (no shell-interpolation of the spec/SEQUANT_PROJECT_DIR).
export function resolveNpxCommand(platform = process.platform) {
  return platform === "win32" ? "npx.cmd" : "npx";
}

function main() {
  const spec = process.argv[2];
  if (!spec) {
    process.stderr.write("mcp-launch: missing package spec argument\n");
    process.exit(1);
  }

  // Claude Code spawns this launcher with cwd = the open project (the same
  // fact that lets a local node_modules/sequant shadow npx in the first
  // place — see the module comment above). SEQUANT_PROJECT_DIR is normally
  // unset; it exists only so a caller invoking this file directly (tests,
  // manual debugging) can override the project dir without changing cwd.
  const projectDir = process.env.SEQUANT_PROJECT_DIR || process.cwd();

  let launchCwd;
  try {
    // A cwd with no package.json/node_modules ancestor forces npx to resolve
    // from its cache/registry instead of a locally shadowing install.
    launchCwd = mkdtempSync(join(tmpdir(), "sequant-mcp-launch-"));
  } catch (err) {
    process.stderr.write(
      `mcp-launch: failed to create an isolated launch directory: ${err.message}\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `mcp-launch: project dir ${projectDir}; launching npx from ${launchCwd}\n`,
  );

  function cleanup() {
    try {
      rmSync(launchCwd, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  const child = spawn(resolveNpxCommand(), ["-y", spec, "serve"], {
    cwd: launchCwd,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, SEQUANT_PROJECT_DIR: projectDir },
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    });
  }

  child.on("error", (err) => {
    process.stderr.write(`mcp-launch: failed to spawn npx: ${err.message}\n`);
    cleanup();
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    cleanup();
    if (signal) {
      // Re-raise the same signal so our own exit reflects the child's cause,
      // rather than translating it into an opaque exit code. Must drop our
      // own SIGINT/SIGTERM listeners first: a process with an active listener
      // for a signal never applies that signal's default (terminate) action,
      // so self-killing while the listener above is still attached routes
      // back into it instead — observed to swallow the signal and fall
      // through to a plain `exit 0` (silently reporting success for a
      // process that was actually killed), rather than reporting the real
      // signal exit our caller needs to see.
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

// Only run when invoked directly (`node mcp-launch.mjs ...`), not when
// imported — lets tests exercise resolveNpxCommand() without triggering the
// spawn side effects above.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
