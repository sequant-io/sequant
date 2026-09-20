/**
 * Writer × destination-state matrix (#1097).
 *
 * Four recent sync/init bugs shared one gap: the writer was tested from a
 * single starting state (#1053 from an empty `scripts/dev`, #1071 on a fresh
 * repo, #1078 against an untouched `.claude/settings.json`, #1030 against a
 * destination another writer owns). This file runs every writer against every
 * destination state, on the real filesystem in a temp dir, and pins what each
 * one does.
 *
 * Axes
 *   writers        init, sync, update — each with and without --force. `sync`
 *                  and `update` also run with --dry-run. `init` has no dry-run.
 *   destinations   one representative per ownership policy in
 *                  `OWNERSHIP_RULES` (read through `ownershipPolicy()`, never
 *                  restated), plus `scripts/dev/<x>.sh` on both routes
 *                  (copy: templates dir outside the project; link: a local
 *                  `node_modules/sequant/templates/scripts`).
 *   states         absent · sequant-owned (byte-identical) · user-modified ·
 *                  marker + changed body · local symlink · foreign symlink ·
 *                  directory in the file's place
 *
 * A writer that never touches a destination is not skipped: its row is `=`
 * for every state, so "sync never touches .gitignore" is asserted, not assumed.
 *
 * Reading the grids: one letter per writer, in `APPLY_WRITERS` order.
 *   =  destination byte-identical (same kind, same symlink target)
 *   T  replaced by a regular file holding the template/generated content
 *   M  merged: the user's content kept, sequant's entry added or re-pinned
 *   L  symlink to the local scripts fixture
 *   W  written THROUGH an existing symlink; the link stays, its target changed
 *   X  writer rejected (raw fs error) and the directory is untouched
 *   V  replaced, but the symlink's old target was modified on the way
 *
 * Cells that pin a defect rather than the intended behaviour are listed in
 * `KNOWN_DEFECTS`, and a test asserts that list is exactly the set of cells
 * that break a policy invariant: fixing a defect fails that test until the
 * entry is removed, so the list cannot go stale. The fixes are out of scope
 * here (#1090 owns the policy); each defect has its own issue.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { initCommand } from "../../commands/init.js";
import { syncCommand } from "../../commands/sync.js";
import { updateCommand } from "../../commands/update.js";
import { getPackageVersion } from "../manifest.js";
import { ownershipPolicy } from "../templates.js";

const REPO_ROOT = realpathSync(resolve(__dirname, "../../.."));
const TEMPLATES_DIR = join(REPO_ROOT, "templates");
const CELL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

type StateId =
  | "absent"
  | "owned"
  | "userModified"
  | "markerChanged"
  | "localSymlink"
  | "foreignSymlink"
  | "directory";

const STATES: { id: StateId; label: string }[] = [
  { id: "absent", label: "absent" },
  { id: "owned", label: "sequant-owned" },
  { id: "userModified", label: "user-modified" },
  { id: "markerChanged", label: "marker + changed body" },
  { id: "localSymlink", label: "local symlink" },
  { id: "foreignSymlink", label: "foreign symlink" },
  { id: "directory", label: "directory" },
];

interface Writer {
  id: string;
  family: "init" | "sync" | "update";
  force: boolean;
  dryRun: boolean;
}

function writer(
  family: Writer["family"],
  force: boolean,
  dryRun = false,
): Writer {
  const id = [family, dryRun ? "--dry-run" : "", force ? "--force" : ""]
    .filter(Boolean)
    .join(" ");
  return { id, family, force, dryRun };
}

/** Column order of every row in `GRID` and `DECISIONS`. */
const APPLY_WRITERS: Writer[] = [
  writer("init", false),
  writer("init", true),
  writer("sync", false),
  writer("sync", true),
  writer("update", false),
  writer("update", true),
];

/** The writers that have a `--dry-run` twin; `init` has none. */
const PAIRED_WRITERS = APPLY_WRITERS.filter((w) => w.family !== "init");

type DestId =
  | "settings"
  | "skill"
  | "constitution"
  | "sequantSettings"
  | "agentsMd"
  | "mcpJson"
  | "gitignore"
  | "scriptsCopy"
  | "scriptsLink";

interface Dest {
  id: DestId;
  path: string;
  /** Scripts only: which `resolveScriptsSymlinkTarget` mode the project is in. */
  route?: "copy" | "link";
  /** Valid content the user (not sequant) wrote. */
  userModified: string;
  /** Sequant's own content with the body changed and the marker kept. */
  markerChanged: (owned: string) => string;
  /** Merge destinations: did the writer keep the user's content and add sequant's? */
  merged?: (before: string, after: string) => boolean;
}

const USER_LINE = "# added by the user";

const DESTS: Dest[] = [
  {
    id: "settings",
    path: ".claude/settings.json",
    userModified: JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "my-hook.sh" }] },
        ],
      },
    }),
    markerChanged: (owned) =>
      JSON.stringify({ ...JSON.parse(owned), userKey: true }, null, 2) + "\n",
  },
  {
    id: "skill",
    path: ".claude/skills/spec/SKILL.md",
    userModified: "# my own spec skill\n",
    markerChanged: (owned) => `${owned}\n${USER_LINE}\n`,
  },
  {
    id: "constitution",
    path: ".claude/memory/constitution.md",
    userModified: "# My constitution\n\nKeep it small.\n",
    markerChanged: (owned) => `${owned}\n${USER_LINE}\n`,
  },
  {
    id: "sequantSettings",
    path: ".sequant/settings.json",
    userModified: JSON.stringify({
      version: "1.0",
      run: { timeout: 999, concurrency: 7 },
    }),
    markerChanged: (owned) => {
      const changed = owned.replace('"timeout": 1800', '"timeout": 4242');
      if (changed === owned) throw new Error("timeout key not found");
      return changed;
    },
  },
  {
    id: "agentsMd",
    path: "AGENTS.md",
    userModified: "# My agents file\n",
    markerChanged: (owned) => `${owned}\n${USER_LINE}\n`,
  },
  {
    id: "mcpJson",
    path: ".mcp.json",
    userModified: JSON.stringify({
      mcpServers: { other: { command: "other-server" } },
    }),
    markerChanged: () =>
      JSON.stringify({
        mcpServers: {
          other: { command: "other-server" },
          sequant: { command: "npx", args: ["-y", "sequant@1.0.0", "serve"] },
        },
      }),
    merged: (before, after) => {
      let a: { mcpServers?: Record<string, { args?: string[] }> };
      try {
        a = JSON.parse(after);
      } catch {
        return false;
      }
      const pin = a.mcpServers?.sequant?.args?.find((x) =>
        x.startsWith("sequant@"),
      );
      if (pin !== `sequant@${getPackageVersion()}`) return false;
      let b: { mcpServers?: Record<string, unknown> };
      try {
        b = JSON.parse(before);
      } catch {
        return false;
      }
      return Object.keys(b.mcpServers ?? {})
        .filter((k) => k !== "sequant")
        .every((k) => a.mcpServers && k in a.mcpServers);
    },
  },
  {
    id: "gitignore",
    path: ".gitignore",
    userModified: "node_modules/\ndist/\n",
    markerChanged: (owned) => `${owned}\n${USER_LINE}\n`,
    merged: (before, after) => {
      const kept = before.split("\n").filter(Boolean);
      const lines = after.split("\n");
      return (
        lines.includes(".sequant/") && kept.every((l) => lines.includes(l))
      );
    },
  },
  {
    id: "scriptsCopy",
    path: "scripts/dev/new-feature.sh",
    route: "copy",
    userModified: "#!/bin/sh\necho mine\n",
    markerChanged: (owned) => `${owned}\n${USER_LINE}\n`,
  },
  {
    id: "scriptsLink",
    path: "scripts/dev/new-feature.sh",
    route: "link",
    userModified: "#!/bin/sh\necho mine\n",
    markerChanged: (owned) => `${owned}\n${USER_LINE}\n`,
  },
];

function destOf(id: DestId): Dest {
  const d = DESTS.find((x) => x.id === id);
  if (!d) throw new Error(`unknown destination ${id}`);
  return d;
}

function destTitle(d: Dest): string {
  const route = d.route ? ` [${d.route} route]` : "";
  return `${d.path} (${ownershipPolicy(d.path)})${route}`;
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

// Filled from observation and reviewed row by row; see the header for letters.
const GRID: Record<DestId, Record<StateId, string>> = {} as never;

// Printed decision for [sync, sync --force, update, update --force]:
//   o overwrite · p preserved · m merged · - nothing printed for this path
const DECISIONS: Record<DestId, Record<StateId, string>> = {} as never;

/** Cells whose observed behaviour breaks a policy invariant; issue per entry. */
const KNOWN_DEFECTS: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let baseline: string;
let scratchRoot: string;
let ownedBytes: Record<DestId, string>;
const saved: Record<string, string | undefined> = {};

interface Snap {
  kind: "absent" | "file" | "dir" | "symlink";
  /** Content read through any symlink; null for absent and directories. */
  bytes: string | null;
  target: string | null;
}

function snap(p: string): Snap {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { kind: "absent", bytes: null, target: null };
  }
  if (st.isDirectory()) return { kind: "dir", bytes: null, target: null };
  const bytes = existsSync(p) ? readFileSync(p, "utf-8") : null;
  if (st.isSymbolicLink()) {
    return { kind: "symlink", bytes, target: readlinkSync(p) };
  }
  return { kind: "file", bytes, target: null };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

interface RunResult {
  lines: string[];
  threw: string | null;
}

async function run(cwd: string, w: Writer): Promise<RunResult> {
  // The one guard that matters: a writer pointed at the real checkout would
  // rewrite the repo this suite runs in (a wave-1 fixture did exactly that).
  const real = realpathSync(cwd);
  expect(real.startsWith(REPO_ROOT + sep) || real === REPO_ROOT).toBe(false);
  expect(real.startsWith(realpathSync(scratchRoot) + sep)).toBe(true);

  const prevCwd = process.cwd();
  const prevExit = process.exitCode;
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(stripAnsi(a.join(" ")));
  });
  let threw: string | null = null;
  process.chdir(cwd);
  try {
    if (w.family === "init") {
      await initCommand({ yes: true, skipSetup: true, force: w.force });
    } else if (w.family === "sync") {
      await syncCommand({ dryRun: w.dryRun, force: w.force });
    } else {
      await updateCommand({ yes: true, dryRun: w.dryRun, force: w.force });
    }
  } catch (e) {
    threw = (e as NodeJS.ErrnoException).code ?? String(e);
  } finally {
    process.chdir(prevCwd);
    process.exitCode = prevExit;
    log.mockRestore();
  }
  return { lines, threw };
}

type Verb = "o" | "p" | "m" | "-";

/** The decision a writer printed for `path`, normalised to one letter. */
function printedDecision(lines: string[], path: string): Verb {
  const verbs: Record<string, Verb> = {
    overwrite: "o",
    preserved: "p",
    merged: "m",
  };
  let section = "";
  let found: Verb = "-";
  for (const raw of lines) {
    const line = raw.trim();
    // sync: `  overwrite: <path>` / `  preserved: <path> — hint` / `  merged: ...`
    const m = /^(overwrite|preserved|merged): (\S+)/.exec(line);
    if (m && m[2] === path) found = verbs[m[1]];
    if (path === "AGENTS.md") {
      if (line === "Regenerated AGENTS.md" || line === "AGENTS.md: regenerate")
        found = "o";
      if (line === "AGENTS.md: preserved") found = "p";
    }
    if (
      path === ".mcp.json" &&
      /^(Would update|Updated) \.mcp\.json MCP pin/.test(line)
    ) {
      found = "m";
    }
    // update: paths listed under a heading.
    if (
      /^(Modified files|New files|Local overrides \(forced overwrite\)):$/.test(
        line,
      )
    ) {
      section = line;
    } else if (line === "" || /:$/.test(line)) {
      if (!/^(Modified files|New files|Local overrides)/.test(line))
        section = "";
    } else if (section && line === path) {
      found = "o";
    }
  }
  return found;
}

function makeBaseline(): string {
  const dir = mkdtempSync(join(scratchRoot, "baseline-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "matrix" }));
  return dir;
}

interface Cell {
  dir: string;
  foreign: string;
  path: string;
  before: Snap;
}

const SCRIPT_NAMES = [
  "cleanup-worktree.sh",
  "list-worktrees.sh",
  "new-feature.sh",
];

/** A fresh project in `state` for `dest`, copied from the initialized baseline. */
function prepare(dest: Dest, state: StateId): Cell {
  const dir = mkdtempSync(join(scratchRoot, "cell-"));
  const foreignDir = mkdtempSync(join(scratchRoot, "foreign-"));
  cpSync(baseline, dir, { recursive: true, verbatimSymlinks: true });
  // A stale version marker sends `sync` down its full-apply path instead of the
  // report-only fast path (which writes nothing).
  writeFileSync(join(dir, ".claude/skills/.sequant-version"), "0.0.0");

  if (dest.route === "link") {
    cpSync(
      join(TEMPLATES_DIR, "scripts"),
      join(dir, "node_modules/sequant/templates/scripts"),
      { recursive: true },
    );
    rmSync(join(dir, "scripts/dev"), { recursive: true, force: true });
    mkdirSync(join(dir, "scripts/dev"), { recursive: true });
    for (const name of SCRIPT_NAMES) {
      symlinkSync(
        join("../../node_modules/sequant/templates/scripts", name),
        join(dir, "scripts/dev", name),
      );
    }
  }

  const p = join(dir, dest.path);
  const owned = ownedBytes[dest.id];
  const clear = (): void => rmSync(p, { recursive: true, force: true });

  switch (state) {
    case "absent":
      clear();
      break;
    case "owned":
      break;
    case "userModified":
      clear();
      writeFileSync(p, dest.userModified);
      break;
    case "markerChanged":
      clear();
      writeFileSync(p, dest.markerChanged(owned));
      break;
    case "localSymlink": {
      clear();
      const target = join(
        dir,
        "node_modules/sequant/templates/local-target.txt",
      );
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, dest.userModified);
      symlinkSync(target, p);
      break;
    }
    case "foreignSymlink": {
      clear();
      const target = join(foreignDir, "target");
      writeFileSync(target, dest.userModified);
      symlinkSync(target, p);
      break;
    }
    case "directory":
      clear();
      mkdirSync(p);
      writeFileSync(join(p, "keep.txt"), "keep");
      break;
  }
  return { dir, foreign: foreignDir, path: p, before: snap(p) };
}

function dispose(cell: Cell): void {
  rmSync(cell.dir, { recursive: true, force: true });
  rmSync(cell.foreign, { recursive: true, force: true });
}

/** Reduce a before/after pair to one grid letter (see the header). */
function classify(
  dest: Dest,
  cell: Cell,
  after: Snap,
  threw: string | null,
): string {
  const before = cell.before;
  const owned = ownedBytes[dest.id];
  const same =
    before.kind === after.kind &&
    before.target === after.target &&
    before.bytes === after.bytes;

  if (threw) {
    return before.kind === "dir" && after.kind === "dir"
      ? "X"
      : `?threw:${threw}`;
  }
  if (same) return "=";
  if (after.kind === "file") {
    // A symlink replaced by a file must leave what it pointed at alone.
    if (before.kind === "symlink" && !symlinkTargetUntouched(cell)) return "V";
    if (after.bytes === owned) return "T";
    if (dest.merged && dest.merged(before.bytes ?? "", after.bytes ?? ""))
      return "M";
    return "?file";
  }
  if (after.kind === "symlink") {
    if (
      dest.route === "link" &&
      after.target?.endsWith(
        "node_modules/sequant/templates/scripts/new-feature.sh",
      ) &&
      after.bytes === owned
    ) {
      return "L";
    }
    if (before.kind === "symlink" && before.target === after.target) {
      if (after.bytes === owned) return "W";
      if (dest.merged && dest.merged(before.bytes ?? "", after.bytes ?? ""))
        return "M";
    }
    return "?symlink";
  }
  return "?";
}

function symlinkTargetUntouched(cell: Cell): boolean {
  // The fixtures write `userModified` into both kinds of symlink target.
  const dest = DESTS.find((d) => cell.path.endsWith(d.path));
  const target = cell.before.target;
  if (!dest || !target) return true;
  return (
    readFileSync(resolve(dirname(cell.path), target), "utf-8") ===
    cell.before.bytes
  );
}

beforeAll(async () => {
  for (const k of ["SEQUANT_TEMPLATES_DIR", "HOME"]) saved[k] = process.env[k];
  scratchRoot = mkdtempSync(join(tmpdir(), "writer-matrix-"));
  process.env.SEQUANT_TEMPLATES_DIR = TEMPLATES_DIR;
  // init reads (never writes) the user's MCP client configs; keep it off the real home.
  process.env.HOME = mkdtempSync(join(scratchRoot, "home-"));

  baseline = makeBaseline();
  const result = await run(baseline, {
    id: "init",
    family: "init",
    force: false,
    dryRun: false,
  });
  expect(result.threw).toBeNull();

  ownedBytes = {} as Record<DestId, string>;
  for (const d of DESTS) {
    ownedBytes[d.id] = readFileSync(join(baseline, d.path), "utf-8");
  }
}, 120_000);

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Generation (temporary)
// ---------------------------------------------------------------------------

if (process.env.WRITER_MATRIX_DUMP) {
  it("dump", async () => {
    const grid: string[] = [];
    const dec: string[] = [];
    for (const dest of DESTS) {
      for (const s of STATES) {
        const codes: string[] = [];
        for (const w of APPLY_WRITERS) {
          const cell = prepare(dest, s.id);
          const r = await run(cell.dir, w);
          codes.push(classify(dest, cell, snap(cell.path), r.threw));
          dispose(cell);
        }
        grid.push(`${dest.id} ${s.id} ${codes.join(" ")}`);
        const ds: string[] = [];
        for (const w of PAIRED_WRITERS) {
          const cell = prepare(dest, s.id);
          const dry = await run(cell.dir, { ...w, dryRun: true });
          const app = await run(cell.dir, w);
          ds.push(
            `${printedDecision(dry.lines, dest.path)}${printedDecision(app.lines, dest.path)}`,
          );
          dispose(cell);
        }
        dec.push(`${dest.id} ${s.id} ${ds.join(" ")}`);
      }
    }
    writeFileSync(
      process.env.WRITER_MATRIX_DUMP as string,
      grid.join("\n") + "\n\n" + dec.join("\n"),
    );
  }, 900_000);
}

describe("placeholder", () => {
  it("has destinations", () => {
    expect(DESTS.length).toBeGreaterThan(0);
    expect(destOf("settings").id).toBe("settings");
    expect(destTitle(DESTS[0])).toContain("sequant-owned");
    expect(CELL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GRID).toBeDefined();
    expect(DECISIONS).toBeDefined();
    expect(KNOWN_DEFECTS).toBeDefined();
    expect(PAIRED_WRITERS.length).toBe(4);
  });
});
