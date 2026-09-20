/**
 * Downstream fixture project for the CI canary (#1098).
 *
 * A builder, not a checked-in tree: it performs a REAL `npm install` of the
 * previous minor release of sequant, runs that release's own `init`, then
 * customizes the project the way real downstream projects do. No mocks (I-6) —
 * a fixture that fakes npm or the old release is exactly the failure mode the
 * canary exists to catch.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const PR_CLI = path.join(REPO_ROOT, "dist", "bin", "cli.js");

export const CUSTOM = {
  constitutionLine: "# Downstream rule: never touch the billing module",
  agentsMd: "# Hand-written AGENTS.md\n\nOwned by this project, not sequant.\n",
  staleDevDependency: "^1.20.0",
  timeout: 5400,
  localSettings: {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo downstream-guard" }],
        },
      ],
    },
  },
} as const;

/** The env every spawned process gets: the suite is not hermetic against SEQUANT_* (#1086). */
export function cleanEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("SEQUANT_")) env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * Highest published `<major>.<minor-1>.x`, derived from this tree's version so
 * it never rots at the next minor bump. Fails loudly when none exists.
 */
export function previousMinorVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version: string };
  const [major, minor] = pkg.version.split(".").map(Number);
  if (!(minor > 0)) {
    throw new Error(
      `cannot derive a previous minor from ${pkg.version}; extend previousMinorVersion()`,
    );
  }
  const range = `${major}.${minor - 1}`;
  const out = execFileSync(
    "npm",
    ["view", `sequant@${range}`, "version", "--json"],
    { encoding: "utf8", env: cleanEnv() },
  ).trim();
  const parsed: string | string[] = JSON.parse(out);
  const versions = Array.isArray(parsed) ? parsed : [parsed];
  if (versions.length === 0) {
    throw new Error(`no published sequant release matches ${range}.x`);
  }
  return versions[versions.length - 1];
}

export interface Fixture {
  dir: string;
  previousVersion: string;
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 180_000,
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stdout}\n${r.stderr}`,
    );
  }
}

export function createDownstreamFixture(): Fixture {
  const previousVersion = previousMinorVersion();
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "sequant-canary-")),
  );

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "downstream-fixture",
      version: "1.0.0",
      private: true,
    }),
  );
  // Set before anything commits: CI has no ambient git identity.
  run("git", ["init", "-q"], dir);
  run("git", ["config", "user.email", "canary@example.com"], dir);
  run("git", ["config", "user.name", "canary"], dir);

  run(
    "npm",
    [
      "install",
      `sequant@${previousVersion}`,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    dir,
  );
  // The previous minor's own `init`, exactly as a real project ran it.
  run(
    process.execPath,
    [
      path.join(dir, "node_modules", "sequant", "dist", "bin", "cli.js"),
      "init",
      "--yes",
      "--skip-setup",
    ],
    dir,
  );

  // Customizations, the way real projects do them.
  const constitution = path.join(dir, ".claude", "memory", "constitution.md");
  fs.appendFileSync(constitution, `\n${CUSTOM.constitutionLine}\n`);
  fs.writeFileSync(
    path.join(dir, ".claude", "settings.local.json"),
    JSON.stringify(CUSTOM.localSettings, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(dir, "AGENTS.md"), CUSTOM.agentsMd);
  const sequantSettings = path.join(dir, ".sequant", "settings.json");
  const tuned = fs
    .readFileSync(sequantSettings, "utf8")
    .replace(/"timeout": \d+/, `"timeout": ${CUSTOM.timeout}`);
  if (!tuned.includes(`"timeout": ${CUSTOM.timeout}`)) {
    throw new Error(".sequant/settings.json has no run.timeout to tune");
  }
  fs.writeFileSync(sequantSettings, tuned);
  // A stale devDependency left over from an old install. Written after the
  // real install, so node_modules still holds the previous minor.
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.devDependencies = {
    ...pkg.devDependencies,
    sequant: CUSTOM.staleDevDependency,
  };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  return { dir, previousVersion };
}

/** Bytes of every customized file, keyed by project-relative path. */
export function customizedFiles(dir: string): Record<string, string> {
  const files = [
    ".claude/memory/constitution.md",
    ".claude/settings.local.json",
    "AGENTS.md",
    ".sequant/settings.json",
    "package.json",
  ];
  return Object.fromEntries(
    files.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
  );
}

/** sha1 of every file outside node_modules/.git, keyed by relative path. */
export function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() || e.isSymbolicLink()) {
        out.set(
          path.relative(dir, full),
          e.isSymbolicLink()
            ? `link:${fs.readlinkSync(full)}`
            : fs.readFileSync(full).toString("base64"),
        );
      }
    }
  };
  walk(dir);
  return out;
}
