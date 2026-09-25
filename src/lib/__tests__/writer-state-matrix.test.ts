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
 *                  `OWNERSHIP_RULES`, as landed by #1090 (the matrix-shape test
 *                  checks each against `ownershipPolicy()`), plus
 *                  `scripts/dev/<x>.sh` on both routes (copy: templates dir
 *                  outside the project; link: a local
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
 * `KNOWN_DEFECTS`, and a test asserts the count of grid cells that break each
 * policy invariant equals the declared count: fixing a defect changes its
 * cells, and the counts fail until the entry is updated, so the list cannot go
 * stale. That list is empty as of #1122, which fixed the last two entries —
 * `W` and `X` stay in the legend because `classify` still reports them, and a
 * regression that reintroduces either fails the invariant test rather than
 * quietly re-pinning itself.
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
  agent?: string;
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

// Filled from observation and reviewed row by row; letters are in the header.
const GRID: Record<DestId, Record<StateId, string>> = {
  settings: {
    absent: "T T T T T T",
    owned: "= = = = = =",
    userModified: "T T T T T T",
    markerChanged: "T T T T T T",
    localSymlink: "T T T T T T",
    foreignSymlink: "T T T T T T",
    directory: "= = = = = =",
  },
  skill: {
    absent: "T T T T T T",
    owned: "= = = = = =",
    userModified: "T T T T T T",
    markerChanged: "T T T T T T",
    localSymlink: "T T T T T T",
    foreignSymlink: "T T T T T T",
    directory: "= = = = = =",
  },
  constitution: {
    absent: "T T T T T T",
    owned: "= = = = = =",
    userModified: "= = = T = T",
    markerChanged: "= = = T = T",
    localSymlink: "= = = T = T",
    foreignSymlink: "= = = T = T",
    directory: "= = = = = =",
  },
  sequantSettings: {
    absent: "T T = = = =",
    owned: "= = = = = =",
    userModified: "= T = = = =",
    markerChanged: "= T = = = =",
    localSymlink: "= T = = = =",
    foreignSymlink: "= T = = = =",
    directory: "= = = = = =",
  },
  agentsMd: {
    absent: "T T = = = =",
    owned: "= = = = = =",
    userModified: "= T = T = =",
    markerChanged: "= T = T = =",
    localSymlink: "= T = T = =",
    foreignSymlink: "= T = T = =",
    directory: "= = = = = =",
  },
  mcpJson: {
    absent: "T T = = = =",
    owned: "= = = = = =",
    userModified: "M M = = = =",
    markerChanged: "= = M M M M",
    localSymlink: "M M = = = =",
    foreignSymlink: "M M = = = =",
    // #1123: init no longer crashes when .mcp.json is a directory — the same
    // unparseable/unreadable guard that leaves corrupt JSON alone leaves a
    // directory alone too, rather than letting the write throw EISDIR.
    directory: "= = = = = =",
  },
  gitignore: {
    absent: "T T = = = =",
    owned: "= = = = = =",
    userModified: "M M = = = =",
    markerChanged: "= = = = = =",
    localSymlink: "M M = = = =",
    foreignSymlink: "M M = = = =",
    directory: "= = = = = =",
  },
  scriptsCopy: {
    absent: "T T T T T T",
    owned: "= = = = = =",
    userModified: "= T T T T T",
    markerChanged: "= T T T T T",
    localSymlink: "T T T T T T",
    foreignSymlink: "T T T T T T",
    directory: "= = = = = =",
  },
  scriptsLink: {
    absent: "L L L L T T",
    owned: "= = = = = =",
    userModified: "= L L L T T",
    markerChanged: "= L L L T T",
    localSymlink: "L L L L T T",
    foreignSymlink: "L L L L T T",
    directory: "= = = = = =",
  },
};

// Printed decision for [sync, sync --force, update, update --force], the same
// for the dry-run and the apply run:
//   o overwrite · p preserved · m merged · - nothing printed for this path
const DECISIONS: Record<DestId, Record<StateId, string>> = {
  settings: {
    absent: "o o o o",
    owned: "- - - -",
    userModified: "o o o o",
    markerChanged: "o o o o",
    localSymlink: "o o o o",
    foreignSymlink: "o o o o",
    directory: "- - - -",
  },
  skill: {
    absent: "o o o o",
    owned: "- - - -",
    userModified: "o o o o",
    markerChanged: "o o o o",
    localSymlink: "o o o o",
    foreignSymlink: "o o o o",
    directory: "- - - -",
  },
  constitution: {
    absent: "o o o o",
    owned: "- - - -",
    userModified: "p o - o",
    markerChanged: "p o - o",
    localSymlink: "p o - o",
    foreignSymlink: "p o - o",
    directory: "- - - -",
  },
  sequantSettings: {
    absent: "- - - -",
    owned: "- - - -",
    userModified: "- - - -",
    markerChanged: "- - - -",
    localSymlink: "- - - -",
    foreignSymlink: "- - - -",
    directory: "- - - -",
  },
  agentsMd: {
    absent: "- - - -",
    owned: "o o - -",
    userModified: "p o - -",
    markerChanged: "p o - -",
    localSymlink: "p o - -",
    foreignSymlink: "p o - -",
    directory: "- - - -",
  },
  mcpJson: {
    absent: "- - - -",
    owned: "- - - -",
    userModified: "- - - -",
    markerChanged: "m m m m",
    localSymlink: "- - - -",
    foreignSymlink: "- - - -",
    directory: "- - - -",
  },
  gitignore: {
    absent: "- - - -",
    owned: "- - - -",
    userModified: "- - - -",
    markerChanged: "- - - -",
    localSymlink: "- - - -",
    foreignSymlink: "- - - -",
    directory: "- - - -",
  },
  scriptsCopy: {
    absent: "o o o o",
    owned: "- - - -",
    userModified: "o o o o",
    markerChanged: "o o o o",
    localSymlink: "o o o o",
    foreignSymlink: "o o o o",
    directory: "- - - -",
  },
  scriptsLink: {
    absent: "o o o o",
    owned: "- - - -",
    userModified: "o o o o",
    markerChanged: "o o o o",
    localSymlink: "o o o o",
    foreignSymlink: "o o o o",
    directory: "- - - -",
  },
};

/**
 * Invariant violations that are pinned, not endorsed. Each is a defect in a
 * writer, tracked in its own issue; `cells` is how many grid cells exhibit it.
 * The two ownership invariants read the policy through `ownershipPolicy()`.
 */
const KNOWN_DEFECTS: Record<string, { issue: string; cells: number }> = {
  // Empty since #1122: the 24 `W` cells and the 32 `X` cells it names were
  // the last two entries. `writeFile` now replaces a symlink instead of
  // following it, and every writer skips a directory at a destination with a
  // named message. A new entry here needs an issue and a cell count; the
  // invariant test below fails while the two disagree, so the list cannot go
  // stale in either direction.
};

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
      await initCommand({
        yes: true,
        skipSetup: true,
        force: w.force,
        agent: w.agent,
      });
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
// Tests
// ---------------------------------------------------------------------------

const LETTERS = new Set(["=", "T", "M", "L", "W", "X", "V"]);

function row(
  grid: Record<DestId, Record<StateId, string>>,
  d: Dest,
  s: StateId,
): string[] {
  return grid[d.id][s].split(" ");
}

describe("matrix shape", () => {
  it("uses the ownership policies #1090 landed, one destination per policy", () => {
    const policies = Object.fromEntries(
      DESTS.map((d) => [d.id, ownershipPolicy(d.path)]),
    );
    expect(policies).toEqual({
      settings: "sequant-owned",
      skill: "sequant-owned",
      constitution: "user-owned",
      sequantSettings: "user-owned",
      agentsMd: "user-owned",
      mcpJson: "merge",
      gitignore: "merge",
      scriptsCopy: "sequant-owned",
      scriptsLink: "sequant-owned",
    });
  });

  it("has a grid entry for every destination, state and writer", () => {
    let cells = 0;
    for (const d of DESTS) {
      for (const s of STATES) {
        const letters = row(GRID, d, s.id);
        expect(letters).toHaveLength(APPLY_WRITERS.length);
        for (const l of letters) expect(LETTERS.has(l)).toBe(true);
        expect(row(DECISIONS, d, s.id)).toHaveLength(PAIRED_WRITERS.length);
        cells += letters.length;
      }
    }
    expect(cells).toBe(DESTS.length * STATES.length * APPLY_WRITERS.length);
  });
});

describe("writer × state: post-state", () => {
  for (const dest of DESTS) {
    describe(destTitle(dest), () => {
      for (const state of STATES) {
        describe(state.label, () => {
          APPLY_WRITERS.forEach((w, col) => {
            it(
              `${w.id} → ${row(GRID, dest, state.id)[col]}`,
              async () => {
                const cell = prepare(dest, state.id);
                try {
                  const result = await run(cell.dir, w);
                  const after = snap(cell.path);
                  expect(classify(dest, cell, after, result.threw)).toBe(
                    row(GRID, dest, state.id)[col],
                  );
                  // The writer's own parity tripwire: sync prints this when the
                  // write path preserved a file the preview never predicted.
                  expect(result.lines.join("\n")).not.toContain(
                    "please report this",
                  );
                } finally {
                  dispose(cell);
                }
              },
              CELL_TIMEOUT_MS,
            );
          });
        });
      }
    });
  }
});

describe("writer × state: dry-run matches apply", () => {
  for (const dest of DESTS) {
    describe(destTitle(dest), () => {
      for (const state of STATES) {
        describe(state.label, () => {
          PAIRED_WRITERS.forEach((w, col) => {
            it(
              `dry-run matches apply: ${w.id} → ${row(DECISIONS, dest, state.id)[col]}`,
              async () => {
                const cell = prepare(dest, state.id);
                try {
                  const expected = row(DECISIONS, dest, state.id)[col];
                  const dry = await run(cell.dir, { ...w, dryRun: true });
                  // A preview writes nothing, not even through a symlink.
                  expect(snap(cell.path)).toEqual(cell.before);

                  const apply = await run(cell.dir, w);
                  const dryVerb = printedDecision(dry.lines, dest.path);
                  const applyVerb = printedDecision(apply.lines, dest.path);

                  expect(dry.threw === null).toBe(apply.threw === null);
                  expect(dryVerb).toBe(applyVerb);
                  expect(dryVerb).toBe(expected);

                  // The verb must describe what the write did.
                  const code = classify(
                    dest,
                    cell,
                    snap(cell.path),
                    apply.threw,
                  );
                  if (applyVerb === "p") expect(code).toBe("=");
                  if (applyVerb === "m") expect(code).toBe("M");
                } finally {
                  dispose(cell);
                }
              },
              CELL_TIMEOUT_MS,
            );
          });
        });
      }
    });
  }
});

describe("policy invariants over the grid", () => {
  const PRESERVED_STATES: StateId[] = [
    "userModified",
    "markerChanged",
    "localSymlink",
    "foreignSymlink",
  ];

  // Only non-zero counts are reported, so the expectation below is exactly
  // `KNOWN_DEFECTS` — including when that list is empty. (Pre-#1122 the
  // initializer had to name every key in advance, and a key it missed
  // incremented `undefined` into `NaN` instead of failing legibly.)
  function violations(): Record<string, number> {
    const counts: Record<string, number> = {};
    const bump = (key: string): void => {
      counts[key] = (counts[key] ?? 0) + 1;
    };
    for (const d of DESTS) {
      const policy = ownershipPolicy(d.path);
      for (const s of STATES) {
        row(GRID, d, s.id).forEach((letter, col) => {
          const force = APPLY_WRITERS[col].force;
          if (
            policy === "user-owned" &&
            !force &&
            PRESERVED_STATES.includes(s.id) &&
            letter !== "="
          ) {
            bump("user-owned-not-preserved-without-force");
          }
          if (
            policy === "sequant-owned" &&
            (s.id === "localSymlink" || s.id === "foreignSymlink") &&
            (letter === "W" || letter === "V")
          ) {
            bump("symlink-written-through-at-sequant-owned");
          }
          if (s.id === "directory" && letter === "X") {
            bump("directory-crashes-writer");
          }
        });
      }
    }
    return counts;
  }

  it("the only cells that break an ownership invariant are the tracked defects", () => {
    const expected = Object.fromEntries(
      Object.entries(KNOWN_DEFECTS).map(([k, v]) => [k, v.cells]),
    );
    expect(violations()).toEqual(expected);
  });

  it("every tracked defect names an open issue", () => {
    for (const v of Object.values(KNOWN_DEFECTS)) {
      expect(v.issue).toMatch(/^#\d+$/);
    }
  });

  it("never lets a merge destination lose the user's content", () => {
    for (const d of DESTS.filter((x) => ownershipPolicy(x.path) === "merge")) {
      for (const s of [
        "userModified",
        "localSymlink",
        "foreignSymlink",
      ] as const) {
        for (const letter of row(GRID, d, s)) {
          expect(["=", "M"]).toContain(letter);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Named cells: the bugs that motivated the matrix
// ---------------------------------------------------------------------------

describe("#1053: foreign symlink in copy mode", () => {
  const dest = destOf("scriptsCopy");

  for (const w of [
    writer("init", false),
    writer("init", true),
    writer("sync", false),
    writer("sync", true),
  ]) {
    it(
      `${w.id}: a foreign symlink at scripts/dev/<x>.sh ends as a regular file with template content`,
      async () => {
        const cell = prepare(dest, "foreignSymlink");
        try {
          expect(cell.before.kind).toBe("symlink");
          const result = await run(cell.dir, w);
          expect(result.threw).toBeNull();

          const st = lstatSync(cell.path);
          expect(st.isSymbolicLink()).toBe(false);
          expect(st.isFile()).toBe(true);
          expect(readFileSync(cell.path, "utf-8")).toBe(
            readFileSync(
              join(TEMPLATES_DIR, "scripts/new-feature.sh"),
              "utf-8",
            ),
          );
          // What the link pointed at (an npx cache, a sibling checkout) is untouched.
          expect(readFileSync(join(cell.foreign, "target"), "utf-8")).toBe(
            dest.userModified,
          );
        } finally {
          dispose(cell);
        }
      },
      CELL_TIMEOUT_MS,
    );
  }
});

describe("#1122: foreign symlink at .claude/settings.json", () => {
  const dest = destOf("settings");

  // The issue's own repro: `ln -s <outside file> .claude/settings.json && sequant sync`.
  // `writeFile` used to follow the link, so the outside file — an npx cache,
  // a sibling checkout, anything — silently took the template's bytes while
  // `.claude/settings.json` stayed a link to it.
  for (const w of [
    writer("sync", false),
    writer("sync", true),
    writer("update", false),
    writer("update", true),
  ]) {
    it(
      `${w.id}: the link is replaced and the outside file it pointed at keeps its bytes`,
      async () => {
        const cell = prepare(dest, "foreignSymlink");
        const foreignFile = join(cell.foreign, "target");
        try {
          expect(cell.before.kind).toBe("symlink");
          expect(realpathSync(cell.path)).toBe(realpathSync(foreignFile));

          const result = await run(cell.dir, w);
          expect(result.threw).toBeNull();

          // What the link pointed at is byte-identical, and still outside the project.
          expect(readFileSync(foreignFile, "utf-8")).toBe(dest.userModified);

          const st = lstatSync(cell.path);
          expect(st.isSymbolicLink()).toBe(false);
          expect(st.isFile()).toBe(true);
          expect(readFileSync(cell.path, "utf-8")).toBe(ownedBytes.settings);
        } finally {
          dispose(cell);
        }
      },
      CELL_TIMEOUT_MS,
    );
  }
});

describe("#1071: init on initialized repo", () => {
  it(
    "init on initialized repo: --agent codex preserves every tuned key and sets only run.agent",
    async () => {
      const tuned = {
        version: "1.0",
        run: {
          timeout: 999,
          concurrency: 7,
          sequential: true,
          phases: ["spec", "exec", "qa"],
          modelRoles: { plan: "opus", build: "sonnet" },
        },
        scopeAssessment: { enabled: false, tuned: [1, 2, 3] },
        customBlock: { keep: "me" },
      };
      const cell = prepare(destOf("sequantSettings"), "owned");
      try {
        const settingsPath = join(cell.dir, ".sequant/settings.json");
        writeFileSync(settingsPath, JSON.stringify(tuned, null, 2));

        const result = await run(cell.dir, {
          id: "init --agent codex",
          family: "init",
          force: false,
          dryRun: false,
          agent: "codex",
        });
        expect(result.threw).toBeNull();

        expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
          ...tuned,
          run: { ...tuned.run, agent: "codex" },
        });
        expect(result.lines.join("\n")).toContain(
          "Preserved existing .sequant/settings.json (updated only run.agent)",
        );
      } finally {
        dispose(cell);
      }
    },
    CELL_TIMEOUT_MS,
  );
});

describe("#1078: settings.local.json survives", () => {
  const LOCAL_SETTINGS = JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "$CLAUDE_PROJECT_DIR/.claude/hooks/mine.sh",
              },
            ],
          },
        ],
      },
      permissions: { allow: ["Bash(npm test)"] },
    },
    null,
    2,
  );

  function project(): Cell {
    const cell = prepare(destOf("settings"), "userModified");
    writeFileSync(
      join(cell.dir, ".claude/settings.local.json"),
      LOCAL_SETTINGS,
    );
    return cell;
  }

  for (const w of [
    writer("sync", false),
    writer("sync", true),
    writer("update", false),
    writer("update", true),
  ]) {
    it(
      `settings.local.json survives ${w.id}; settings.json is overwritten with the template`,
      async () => {
        const cell = project();
        try {
          const result = await run(cell.dir, w);
          expect(result.threw).toBeNull();

          expect(
            readFileSync(
              join(cell.dir, ".claude/settings.local.json"),
              "utf-8",
            ),
          ).toBe(LOCAL_SETTINGS);
          expect(readFileSync(cell.path, "utf-8")).toBe(ownedBytes.settings);
        } finally {
          dispose(cell);
        }
      },
      CELL_TIMEOUT_MS,
    );
  }

  it(
    "settings.local.json survives sync --dry-run, which lists .claude/settings.json as overwrite",
    async () => {
      const cell = project();
      try {
        const result = await run(cell.dir, writer("sync", false, true));
        expect(result.threw).toBeNull();

        expect(printedDecision(result.lines, ".claude/settings.json")).toBe(
          "o",
        );
        expect(
          printedDecision(result.lines, ".claude/settings.local.json"),
        ).toBe("-");
        expect(
          readFileSync(join(cell.dir, ".claude/settings.local.json"), "utf-8"),
        ).toBe(LOCAL_SETTINGS);
        expect(snap(cell.path)).toEqual(cell.before);
      } finally {
        dispose(cell);
      }
    },
    CELL_TIMEOUT_MS,
  );
});
