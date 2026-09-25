/**
 * Template management - copy and process templates
 */

import { readdir, chmod, stat } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join, dirname, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { diffLines } from "diff";
import {
  readFile,
  writeFile,
  ensureDir,
  fileExists,
  isSymlink,
  isDirectory,
  getSymlinkTarget,
  createSymlink,
  removeFileOrSymlink,
} from "./fs.js";
import { getPackageVersion } from "./manifest.js";

const SKILLS_VERSION_PATH = ".claude/skills/.sequant-version";
import { getStackConfig, getStackNotes, getMultiStackNotes } from "./stacks.js";
import { isNativeWindows } from "./system.js";
import { getProjectName } from "./project-name.js";

/**
 * Offsets from this module's directory to the bundled `templates/` root, in
 * probe order. This module lives at `src/lib/templates.ts`, so it sits three
 * levels below the package root once compiled (`dist/src/lib/templates.js`) but
 * only two when executed straight from source under `tsx` (`src/lib/`).
 *
 * The compiled offset is listed first so consumers — who always run the compiled
 * binary — keep byte-identical behavior. See #822.
 */
const TEMPLATES_DIR_OFFSETS = [
  ["..", "..", "..", "templates"], // compiled: dist/src/lib → <pkg>/templates
  ["..", "..", "templates"], // source (tsx): src/lib → <repo>/templates
] as const;

/**
 * How well a candidate path matches "the templates root of *this* package".
 *
 * `package-root` outranks `exists` because the two offsets are not mutually
 * exclusive: from a source tree at `<repo>/src/lib`, the *compiled* offset
 * resolves to `<repo>/../templates` — a directory one level **above** the repo.
 * A bare existence probe would happily bind to an unrelated `templates/` that
 * happens to sit beside the checkout. Requiring the candidate's parent to be
 * the sequant package root removes that ambiguity without walking the tree.
 */
export type TemplatesCandidateRank = "package-root" | "exists" | "missing";

/**
 * Resolve the templates root relative to a module directory, given a ranking
 * function.
 *
 * Split out from `getTemplatesDir` purely so both layouts are testable: a test
 * cannot relocate `import.meta.url`, so without injection the "works from both
 * layouts" assertion could only ever exercise whichever layout the test runner
 * happens to use.
 *
 * Resolution order: the first `package-root` candidate, else the first that
 * merely `exists` (keeps any layout that works today working, even one whose
 * package root is not where we expect), else the **compiled** offset — so the
 * caller's error message names the canonical expected location rather than a
 * source-tree guess.
 */
export function resolveTemplatesDirFrom(
  baseDir: string,
  rank: (candidate: string) => TemplatesCandidateRank,
): string {
  const candidates = TEMPLATES_DIR_OFFSETS.map((offset) =>
    join(baseDir, ...offset),
  );
  const ranked = candidates.map((candidate) => ({
    candidate,
    rank: rank(candidate),
  }));

  return (
    ranked.find((c) => c.rank === "package-root")?.candidate ??
    ranked.find((c) => c.rank === "exists")?.candidate ??
    candidates[0]
  );
}

/**
 * Rank a candidate by checking whether it exists and whether its parent is the
 * sequant package root. Anchoring on `package.json` mirrors how every other
 * root resolver in this codebase locates the package (`version.ts`,
 * `manifest.ts`, `bin/preflight.ts`).
 */
function rankTemplatesCandidate(candidate: string): TemplatesCandidateRank {
  if (!existsSync(candidate)) {
    return "missing";
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(candidate, "..", "package.json"), "utf-8"),
    );
    if (pkg.name === "sequant") {
      return "package-root";
    }
  } catch {
    // No readable/parseable package.json beside it — still a usable directory,
    // just not a positively identified package root.
  }
  return "exists";
}

/**
 * Memoized bundled-templates path. Resolution is now stat-backed rather than a
 * pure string join, and `getTemplateContent` calls it once per template file
 * during a drift scan — ~2ms per scan uncached, on a pre-flight path #708
 * deliberately keeps in the 2-5ms range. The install layout cannot change
 * within a process, so caching it is safe. Only the *bundled* resolution is
 * cached; the env override is re-read every call, so tests that set and unset
 * `SEQUANT_TEMPLATES_DIR` are unaffected.
 */
let cachedBundledTemplatesDir: string | undefined;

// Get the package templates directory
export function getTemplatesDir(): string {
  // Allow overriding the templates source (used by tests; also lets the dir be
  // relocated without relying on the compiled-output layout below). Returned
  // verbatim — the override is authoritative and is never probed, so a bad
  // value surfaces at `assertTemplatesDirExists` rather than silently falling
  // back to the bundled tree.
  if (process.env.SEQUANT_TEMPLATES_DIR) {
    return process.env.SEQUANT_TEMPLATES_DIR;
  }

  if (cachedBundledTemplatesDir === undefined) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    cachedBundledTemplatesDir = resolveTemplatesDirFrom(
      __dirname,
      rankTemplatesCandidate,
    );
  }
  return cachedBundledTemplatesDir;
}

/**
 * Resolve the templates root and fail loudly when it does not exist.
 *
 * A missing templates *root* means the install is broken: every `copyDir` call
 * below would hit `copyDir`'s per-directory ENOENT skip, no-op, and let the
 * caller print a success message over an empty tree (#822). That skip is
 * deliberate for individual subdirectories — a stack may legitimately ship
 * without `memory/` — but it must not absorb the whole source tree.
 *
 * Throws rather than printing so the lib layer stays free of presentation;
 * commands catch and render.
 */
export async function assertTemplatesDirExists(): Promise<string> {
  const templatesDir = getTemplatesDir();
  // A *directory* check, not a bare existence check: a stray file at that path
  // would pass `access()` and then fail deeper in `readdir` with the same silent
  // ENOTDIR-shaped confusion this guard exists to prevent.
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(templatesDir)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (isDirectory) {
    return templatesDir;
  }
  throw new Error(
    `Bundled templates directory not found: ${templatesDir}\n` +
      "This usually means the Sequant install is incomplete or was run from an unexpected layout.\n" +
      "Reinstall sequant, or set SEQUANT_TEMPLATES_DIR to the templates/ directory.",
  );
}

/**
 * Process template variables in content
 */
export function processTemplate(
  content: string,
  variables: Record<string, string>,
): string {
  let result = content;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

/**
 * List all template files
 */
export async function listTemplateFiles(): Promise<string[]> {
  const templatesDir = getTemplatesDir();
  const files: string[] = [];

  async function walk(dir: string, prefix: string = ""): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = join(prefix, entry.name);
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath, relativePath);
        } else {
          files.push(join("templates", relativePath));
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await walk(templatesDir);
  return files;
}

/**
 * Get content of a template file
 */
export async function getTemplateContent(
  templatePath: string,
): Promise<string> {
  const templatesDir = getTemplatesDir();
  const relativePath = templatePath.replace("templates/", "");
  const fullPath = join(templatesDir, relativePath);

  return readFile(fullPath);
}

/**
 * How a destination sequant writes is *owned* — the one rule every writer
 * (`init`, `sync`, `update`) consults before it touches a project file.
 *
 * - `sequant-owned` — sequant's own output. Overwrite freely (skills, agents,
 *   hooks, `scripts/dev`). Reported as `overwrite`.
 * - `user-owned` — the project's file. Never written over once it exists and
 *   diverges, unless the user passes an explicit `--force`. Reported as
 *   `preserved`.
 * - `merge` — a file shared with other tools. sequant's own entries are
 *   ensured and everything else in it is kept. Reported as `merged`.
 *
 * Six separate defects (#708, #814, #990, #1030/#1042, #1071, #1078) were the
 * same bug: a writer defaulted to overwrite and nobody was asked to declare
 * otherwise. The policy lives here, next to the routing table, so that
 * `templateDestination` (diff path) and `copyTemplates` (write path) — the two
 * routers whose drift caused #708 and #1030 — read the same declaration.
 */
export type OwnershipPolicy = "sequant-owned" | "user-owned" | "merge";

interface OwnershipRule {
  /** Destination path, forward slashes. */
  readonly match: string;
  /** `exact` matches the whole path; `prefix` matches anything beneath it. */
  readonly kind: "exact" | "prefix";
  readonly policy: OwnershipPolicy;
  /** Why this destination carries this policy. The declaration is the point. */
  readonly reason: string;
}

/**
 * The ownership table. Order matters: the first matching rule wins, so exact
 * rules precede the prefix rules they sit inside. Anything unmatched falls
 * through to `sequant-owned` — the safe default *only* because the AC-2 gate
 * test forces every real destination onto this table before it can ship.
 */
const OWNERSHIP_RULES: readonly OwnershipRule[] = [
  {
    match: ".claude/memory/constitution.md",
    kind: "exact",
    policy: "user-owned",
    reason:
      "Edited in place per project. Silently overwriting it is #814; the " +
      "preserve/report pattern the other user-owned entries follow started here.",
  },
  {
    match: ".sequant/settings.json",
    kind: "exact",
    policy: "user-owned",
    reason:
      "The project's tuned run/phase/model configuration. `init` on an " +
      "already-initialized repo merges in only the keys its flags set and " +
      "leaves everything else byte-identical (#1071).",
  },
  {
    match: "AGENTS.md",
    kind: "exact",
    policy: "user-owned",
    reason:
      "Regenerated only while it still carries an unmodified " +
      "`<!-- sequant:agents-md v= h= -->` marker. An unmarked or hand-edited " +
      "file belongs to the project and is left alone and reported (#990).",
  },
  {
    match: ".mcp.json",
    kind: "exact",
    policy: "merge",
    reason:
      "Shared with every other MCP server the project registers. " +
      "`syncSequantMcpPin` re-pins only the `sequant` entry and keeps the " +
      "rest of the file (#793).",
  },
  {
    match: ".opencode/opencode.json",
    kind: "exact",
    policy: "merge",
    reason:
      "opencode's own config, shared the same way `.mcp.json` is: " +
      "`writeOpencodeMcpConfig` merges in only the `mcp.sequant` entry (#996).",
  },
  {
    match: ".claude/settings.json",
    kind: "exact",
    policy: "sequant-owned",
    reason:
      "Overwritten by design. `.claude/settings.local.json` is the supported, " +
      "update-safe extension point — Claude Code merges it over this file, so " +
      "project hooks and permissions belong there, not here. Ruled on when " +
      "#1078 was closed; see docs/guides/customization.md. Do not make this " +
      "`merge` without reopening that ruling.",
  },
  {
    match: ".opencode/",
    kind: "prefix",
    policy: "sequant-owned",
    reason:
      "Commands, agent defs and the hook plugin are translated from sequant's " +
      "own templates by `init`'s `writeOpencode*` renderers and refreshed " +
      "wholesale (#1030/#1042). The MCP config above is the one exception.",
  },
  {
    match: ".codex/",
    kind: "prefix",
    policy: "sequant-owned",
    reason:
      "`.codex/config.toml` is rendered from `templates/codex/config.toml` by " +
      "`writeCodexConfig` and refreshed wholesale (#1059).",
  },
  {
    match: ".sequant/settings.reference.md",
    kind: "exact",
    policy: "sequant-owned",
    reason:
      "Generated documentation of the settings schema, not configuration. " +
      "Regenerated on every `init` so it cannot drift from the schema.",
  },
  {
    match: ".gitignore",
    kind: "exact",
    policy: "merge",
    reason:
      "The project's file. `init` appends its `.sequant/` entries only when " +
      "they are absent and never rewrites existing lines.",
  },
];

/**
 * The ownership policy declared for a destination sequant writes.
 *
 * `init`, `sync` and `update` all route their preserve-vs-overwrite decision
 * through this function — it is the only source. Adding a new destination
 * without adding it to {@link OWNERSHIP_RULES} or
 * {@link NON_TEMPLATE_DESTINATIONS} fails the AC-2 gate test.
 */
export function ownershipPolicy(destinationPath: string): OwnershipPolicy {
  // Normalize OS path separators so the table matches on Windows too, where
  // destinations are assembled with backslashes (#708).
  const normalized = destinationPath.replace(/\\/g, "/");
  for (const rule of OWNERSHIP_RULES) {
    const hit =
      rule.kind === "exact"
        ? normalized === rule.match
        : normalized.startsWith(rule.match);
    if (hit) return rule.policy;
  }
  return "sequant-owned";
}

/**
 * Destinations sequant writes that do **not** come from the
 * `templates/** ` → `.claude/**` copy route, and therefore cannot be reached by
 * walking the templates tree.
 *
 * This list exists because four of the six defects in the clobbering class
 * (#990 `AGENTS.md`, #1030/#1042 `.opencode/**`, #1071 `.sequant/settings.json`,
 * #1053 `scripts/dev` symlinks) live *outside* `templates/`. A gate that walked
 * only the templates tree would have caught #814 and #1078 and missed the rest,
 * so the AC-2 gate asserts this list exhaustive against the `writeFile(` targets
 * in `init.ts`, `sync.ts` and `update.ts`.
 *
 * Prefix entries end in `/`.
 */
export const NON_TEMPLATE_DESTINATIONS: readonly string[] = [
  ".gitignore",
  ".sequant/settings.json",
  ".sequant/settings.reference.md",
  ".claude/skills/.sequant-version",
  ".claude/.sequant/.skills-drift-cache.json",
  "AGENTS.md",
  ".mcp.json",
  // The exact path, not just the `.opencode/` prefix: it is the one file under
  // that tree sequant merges rather than overwrites, and the gate maps
  // `writeOpencodeMcpConfig` to it so the `merge` rule is actually enforced
  // instead of shadowed by the prefix entry below.
  ".opencode/opencode.json",
  ".opencode/",
  ".codex/config.toml",
];

/**
 * Build the full set of template variables used when rendering templates.
 *
 * This is the single source of truth shared by `copyTemplates` (write time)
 * and `computeTemplateChanges` (diff time) so the two can never drift — a
 * mismatch here is what caused `constitution.md` to read as "modified" on
 * every project (the diff used a different/incomplete variable set than the
 * write). See #708.
 */
export async function buildTemplateVariables(
  stack: string,
  tokens?: Record<string, string>,
  options: { additionalStacks?: string[] } = {},
): Promise<Record<string, string>> {
  const stackConfig = getStackConfig(stack);

  // Detect project name from available sources (package.json, Cargo.toml, etc.)
  const projectName = await getProjectName();

  // Get stack-specific notes for constitution template
  // Use multi-stack notes if additional stacks are provided
  const stackNotes =
    options.additionalStacks && options.additionalStacks.length > 0
      ? getMultiStackNotes(stack, options.additionalStacks)
      : getStackNotes(stack);

  return {
    ...stackConfig.variables,
    ...tokens,
    PROJECT_NAME: projectName,
    STACK: stack,
    STACK_NOTES: stackNotes,
  };
}

/**
 * A single template file's status relative to the installed copy.
 */
export interface TemplateChange {
  /** Installed path under `.claude/` */
  path: string;
  /** Source template path under `templates/` */
  templatePath: string;
  /**
   * `directory-collision` means a directory sits where this file goes. It is
   * reported and skipped, never written — reading or writing the path would
   * throw a raw `EISDIR` and abort the run partway, dry-runs included (#1122).
   */
  status:
    "new" | "modified" | "unchanged" | "local-override" | "directory-collision";
  /** Template content rendered with the project's variables */
  rendered: string;
  /** Unified-ish diff (installed → rendered), only set for `modified` */
  diff?: string;
}

/**
 * A declared route from a bundled template prefix to its install destination.
 * `destination: null` means the copy/diff cycle deliberately does not manage
 * the tree — a different renderer owns it.
 */
interface TemplateRoute {
  /** Template path or prefix under `templates/`, forward slashes. */
  readonly match: string;
  readonly kind: "exact" | "prefix";
  /** Destination path or prefix, or `null` when unmanaged by copy/diff. */
  readonly destination: string | null;
  readonly reason: string;
}

/**
 * Every declared route out of `templates/`. Order matters: exact rules precede
 * the prefixes they sit inside.
 *
 * A new top-level tree under `templates/` that is not listed here has no
 * declared route, and the AC-2 gate test fails naming it (#1090). That is the
 * whole point: before this table, a new template inherited `.claude/<relpath>`
 * and overwrite silently, and nobody was ever asked to declare otherwise.
 */
const TEMPLATE_ROUTES: readonly TemplateRoute[] = [
  {
    match: "templates/mcp.json",
    kind: "exact",
    destination: null,
    reason:
      "The project `.mcp.json` is generated and version-pinned by " +
      "`mcp-config.ts` (`syncSequantMcpPin`), never copied.",
  },
  {
    match: "templates/settings.json",
    kind: "exact",
    destination: ".claude/settings.json",
    reason:
      "Written by `copyTemplates` after the tree copies. Declared " +
      "`sequant-owned`; `.claude/settings.local.json` is the extension point.",
  },
  {
    match: "templates/relay/",
    kind: "prefix",
    destination: null,
    reason: "Not installed by `copyTemplates`.",
  },
  {
    match: "templates/opencode/",
    kind: "prefix",
    destination: null,
    reason:
      "Not a flat copy target. `command.md` needs per-phase `{{PHASE}}` " +
      "substitution (one template, N output files) and the plugin/agents/MCP " +
      "files live under `.opencode/`, not `.claude/` — `init.ts`'s " +
      "`writeOpencode*` functions are the one renderer for this tree, reused " +
      "by `sync`/`update` via `decideOpencodeShimSync` (#1030).",
  },
  {
    match: "templates/codex/",
    kind: "prefix",
    destination: null,
    reason:
      "Same reasoning as opencode above. `config.toml` renders to " +
      "`.codex/config.toml`, not `.claude/` — `init.ts`'s " +
      "`writeCodexProvisioning` is the one renderer (#1059).",
  },
  {
    match: "templates/scripts/",
    kind: "prefix",
    destination: "scripts/dev/",
    reason: "Symlinked on POSIX, copied on Windows / `--no-symlinks`.",
  },
  {
    match: "templates/skills/",
    kind: "prefix",
    destination: ".claude/skills/",
    reason: "Managed skill tree, refreshed wholesale on every sync.",
  },
  {
    match: "templates/agents/",
    kind: "prefix",
    destination: ".claude/agents/",
    reason: "Managed subagent definitions, refreshed wholesale.",
  },
  {
    match: "templates/hooks/",
    kind: "prefix",
    destination: ".claude/hooks/",
    reason: "Managed hook scripts, refreshed wholesale.",
  },
  {
    match: "templates/memory/",
    kind: "prefix",
    destination: ".claude/memory/",
    reason:
      "Holds the constitution, which is declared `user-owned` and preserved " +
      "unless the user passes `--force` (#814).",
  },
];

/**
 * The declared route for a bundled template, or `undefined` when none is
 * declared. `undefined` is the gate's failure signal, not a runtime error —
 * see {@link templateDestination} for what actually happens at runtime.
 */
export function resolveTemplateRoute(
  templatePath: string,
): TemplateRoute | undefined {
  const normalized = templatePath.replace(/\\/g, "/");
  return TEMPLATE_ROUTES.find((route) =>
    route.kind === "exact"
      ? normalized === route.match
      : normalized.startsWith(route.match),
  );
}

/**
 * Map a bundled template path to the location `copyTemplates` installs it to,
 * or `null` for templates the copy/diff cycle does not manage.
 *
 * Reads {@link TEMPLATE_ROUTES}, which `copyTemplates` (write time) and
 * `computeTemplateChanges` (diff time) both consult, so the two routers can
 * never drift — `.claude/mcp.json`, `.claude/relay/*` and `.claude/scripts/*`
 * read as phantom "new" files on every fresh install when the diff assumed a
 * flat `.claude/<relpath>` layout. #708 gives the same guarantee for the
 * template *variables*; this covers the *destinations*, and #1090 adds the
 * ownership policy per destination.
 *
 * An unrouted path still falls back to `.claude/<relpath>` so behaviour is
 * unchanged for anything already shipping; the AC-2 gate test is what forces a
 * new tree onto the table before it can reach a release.
 */
export function templateDestination(templatePath: string): string | null {
  const normalized = templatePath.replace(/\\/g, "/");
  const route = resolveTemplateRoute(normalized);
  if (route) {
    if (route.destination === null) return null;
    return route.kind === "exact"
      ? route.destination
      : normalized.replace(route.match, route.destination);
  }
  return normalized.replace("templates/", ".claude/");
}

/**
 * Compare bundled template content against what's installed under `.claude/`.
 *
 * Templates are rendered with the project's variables *before* comparison, so
 * an unmodified file (e.g. a constitution with `{{PROJECT_NAME}}` expanded)
 * reads as `unchanged` rather than `modified`. A file that diverges in place is
 * `local-override` (skip-by-default) when it has a parallel `.claude/.local/`
 * file or is in the customizable allow-list; otherwise it is `modified`.
 */
export async function computeTemplateChanges(
  stack: string,
  tokens?: Record<string, string>,
  options: { additionalStacks?: string[] } = {},
): Promise<TemplateChange[]> {
  const variables = await buildTemplateVariables(stack, tokens, options);
  const templateFiles = await listTemplateFiles();
  const changes: TemplateChange[] = [];

  for (const templatePath of templateFiles) {
    // templateDestination normalizes separators (listTemplateFiles builds
    // paths with the OS separator, backslashes on Windows — #708) and applies
    // the same routing copyTemplates uses at write time.
    const localPath = templateDestination(templatePath);
    if (localPath === null) {
      continue;
    }

    // Skip .local files (user customizations are never overwritten)
    if (localPath.includes(".local/")) {
      continue;
    }

    const rendered = processTemplate(
      await getTemplateContent(templatePath),
      variables,
    );
    // `fileExists` answers true for a directory, so this has to come first:
    // the `readFile` below would throw EISDIR and take the whole preview with
    // it, before a single line was printed (#1122).
    if (await isDirectory(localPath)) {
      changes.push({
        path: localPath,
        templatePath,
        status: "directory-collision",
        rendered,
      });
      continue;
    }

    const exists = await fileExists(localPath);

    if (!exists) {
      changes.push({ path: localPath, templatePath, status: "new", rendered });
      continue;
    }

    const localContent = await readFile(localPath);
    if (localContent === rendered) {
      changes.push({
        path: localPath,
        templatePath,
        status: "unchanged",
        rendered,
      });
      continue;
    }

    // Content differs after rendering. Protect in-place customizations:
    // a parallel `.claude/.local/` override, or a known customizable file.
    //
    // Note: this protects a managed file that was *edited in place* (e.g. the
    // constitution) when a parallel `.claude/.local/` twin exists. It is NOT a
    // skill-loading mechanism — the harness never loads `.claude/.local/skills/
    // <name>/SKILL.md`, so a full-file SKILL.md shadow does nothing at runtime
    // (#711). Skills are instead customized via a runtime overlay: each managed
    // SKILL.md opens (before its first heading) with a directive to honor
    // `.claude/.local/skills/<name>/overrides.md`, and that overrides file is
    // auto-skipped above because it lives under `.local/`. The directive sits at
    // the top, not end-of-file, so it fires reliably even in 3000-line skills.
    // See docs/guides/customization.md.
    // Only `.claude/` files have `.local/` twins; for `scripts/dev/` paths the
    // replace would be a no-op and the file would shadow itself as its own
    // "override".
    const hasLocalOverride =
      localPath.startsWith(".claude/") &&
      (await fileExists(localPath.replace(".claude/", ".claude/.local/")));

    if (hasLocalOverride || ownershipPolicy(localPath) === "user-owned") {
      changes.push({
        path: localPath,
        templatePath,
        status: "local-override",
        rendered,
      });
      continue;
    }

    const diff = diffLines(localContent, rendered)
      .map((part) => {
        const prefix = part.added ? "+" : part.removed ? "-" : " ";
        return part.value
          .split("\n")
          .filter((l) => l)
          .map((l) => `${prefix} ${l}`)
          .join("\n");
      })
      .join("\n");
    changes.push({
      path: localPath,
      templatePath,
      status: "modified",
      rendered,
      diff,
    });
  }

  return changes;
}

/**
 * Result of symlink creation attempt
 */
export interface SymlinkResult {
  created: boolean;
  path: string;
  target: string;
  fallbackToCopy: boolean;
  skipped: boolean;
  reason?: string;
  /** Skipped because a directory sits at the destination (#1122). */
  directoryCollision?: boolean;
}

/**
 * Options for copyTemplates
 */
export interface CopyTemplatesOptions {
  /** Use copies instead of symlinks for scripts (Windows default or user preference) */
  noSymlinks?: boolean;
  /** Force replacement of existing files/symlinks */
  force?: boolean;
  /**
   * Opt in to overwriting `user-owned` destinations (e.g. the constitution)
   * that already exist and differ from the rendered template. Deliberately
   * separate from `force`: `force` refreshes the managed skills/agents/hooks
   * trees, but that always-on tree overwrite must NOT imply consent to clobber
   * user-owned files. Only an explicit user `--force` sets this. A missing or
   * identical user-owned file is written regardless (#814).
   */
  overwriteCustomizable?: boolean;
  /** Additional stacks to include in constitution notes (for multi-stack projects) */
  additionalStacks?: string[];
}

/**
 * Create symlinks for files in a directory, with fallback to copy
 * @param srcDir Source directory containing template files
 * @param destDir Destination directory for symlinks
 * @param options Options controlling symlink behavior
 * @returns Array of results for each file
 */
export async function symlinkDir(
  srcDir: string,
  destDir: string,
  options: { force?: boolean } = {},
): Promise<SymlinkResult[]> {
  const results: SymlinkResult[] = [];

  try {
    const entries = await readdir(srcDir, { withFileTypes: true });
    await ensureDir(destDir);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Recursively handle subdirectories
        const subResults = await symlinkDir(
          join(srcDir, entry.name),
          join(destDir, entry.name),
          options,
        );
        results.push(...subResults);
        continue;
      }

      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      // Calculate relative path from destDir to srcPath for portable symlinks
      // Note: srcPath may already be absolute (when srcDir is absolute), so check first
      const absoluteDest = isAbsolute(destPath)
        ? destPath
        : join(process.cwd(), destPath);
      const absoluteSrc = isAbsolute(srcPath)
        ? srcPath
        : join(process.cwd(), srcPath);
      const relativeTarget = relative(dirname(absoluteDest), absoluteSrc);

      // A directory at the destination is reported and skipped. Without this
      // the `--force` path unlinks nothing (unlink refuses a directory) and
      // `createSymlink` aborts the whole run with a raw EEXIST (#1122).
      if (await isDirectory(destPath)) {
        results.push({
          created: false,
          path: destPath,
          target: relativeTarget,
          fallbackToCopy: false,
          skipped: true,
          directoryCollision: true,
          reason: "destination is a directory",
        });
        continue;
      }

      // Check if destination already exists
      // Note: isSymlink uses lstat and works on broken symlinks,
      // while fileExists uses access which fails on broken symlinks
      const destIsSymlink = await isSymlink(destPath);
      const destExists = destIsSymlink || (await fileExists(destPath));

      if (destExists && !destIsSymlink && !options.force) {
        // Regular file exists and force not specified - skip
        results.push({
          created: false,
          path: destPath,
          target: relativeTarget,
          fallbackToCopy: false,
          skipped: true,
          reason: "existing file (use --force to replace)",
        });
        continue;
      }

      // Remove existing file/symlink if force or if it's already a symlink
      // (symlinks are always replaced to ensure they point to correct target)
      if (destExists && (options.force || destIsSymlink)) {
        await removeFileOrSymlink(destPath);
      }

      // Try to create symlink
      const symlinkCreated = await createSymlink(relativeTarget, destPath);

      if (symlinkCreated) {
        results.push({
          created: true,
          path: destPath,
          target: relativeTarget,
          fallbackToCopy: false,
          skipped: false,
        });
      } else {
        // Symlink failed (likely Windows without privileges) - fall back to copy
        const content = await readFile(srcPath);
        await writeFile(destPath, content);

        // Make shell scripts executable
        if (entry.name.endsWith(".sh")) {
          await chmod(destPath, 0o755);
        }

        results.push({
          created: true,
          path: destPath,
          target: relativeTarget,
          fallbackToCopy: true,
          skipped: false,
          reason: "symlink not supported, copied instead",
        });
      }
    }
  } catch (error) {
    // Skip if source doesn't exist
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return results;
}

/**
 * Where `scripts/dev/*.sh` symlinks should point, and whether they should be
 * symlinks at all (#990).
 *
 * A symlink target must survive `git clone && npm install` on any machine —
 * it cannot be an npx cache path (evicted between runs → dead links) or an
 * `npm link`/global-prefix sibling (only valid on the machine that ran the
 * command). Preference order:
 *
 * 1. `<project>/node_modules/sequant/templates/scripts` — a real, installed
 *    devDependency, if present, regardless of which `sequant` binary actually
 *    ran the command (AC-4).
 * 2. The resolved bundled templates dir, *unless* it sits under an npx cache
 *    (`_npx` path segment) or outside the project tree — those cases fall
 *    back to copies instead of links (AC-5).
 */
export interface ScriptsSymlinkTarget {
  mode: "symlink" | "copy";
  /** Directory containing the scripts to link/copy from. */
  scriptsDir: string;
  /** Set when `mode === "copy"` because of npx-cache/outside-tree detection. */
  reason?: string;
}

function isUnderNpxCache(dirPath: string): boolean {
  return dirPath.split(/[\\/]/).includes("_npx");
}

function isOutsideProjectTree(dirPath: string): boolean {
  const rel = relative(process.cwd(), dirPath);
  // `..` alone or `../...`/`..\...` (either separator, so this holds on
  // Windows too — relative() itself picks the platform separator).
  return rel.startsWith("..") || isAbsolute(rel);
}

export function resolveScriptsSymlinkTarget(
  bundledTemplatesDir: string,
): ScriptsSymlinkTarget {
  const localNodeModulesScripts = join(
    process.cwd(),
    "node_modules",
    "sequant",
    "templates",
    "scripts",
  );
  if (existsSync(localNodeModulesScripts)) {
    return { mode: "symlink", scriptsDir: localNodeModulesScripts };
  }

  const bundledScriptsDir = join(bundledTemplatesDir, "scripts");
  if (
    isUnderNpxCache(bundledTemplatesDir) ||
    isOutsideProjectTree(bundledTemplatesDir)
  ) {
    return {
      mode: "copy",
      scriptsDir: bundledScriptsDir,
      reason:
        "scripts/dev templates dir is outside the project tree (npx cache or a sibling checkout) — copying instead of symlinking; pass --no-symlinks to silence this",
    };
  }

  return { mode: "symlink", scriptsDir: bundledScriptsDir };
}

/**
 * Preview what each `scripts/dev/*.sh` symlink's target would become without
 * writing anything (#990 AC-6). In copy mode the only change is an existing
 * symlink being replaced by a copy, reported as `newTarget: "(copy)"` (#1053).
 */
export interface ScriptsSymlinkPreviewEntry {
  path: string;
  oldTarget: string | null;
  newTarget: string;
  changed: boolean;
}

export async function previewScriptsSymlinkTargets(): Promise<
  ScriptsSymlinkPreviewEntry[]
> {
  const target = resolveScriptsSymlinkTarget(getTemplatesDir());
  const copyMode = target.mode !== "symlink" || isNativeWindows();

  const entries: ScriptsSymlinkPreviewEntry[] = [];

  async function walk(srcDir: string, destDir: string): Promise<void> {
    let dirEntries;
    try {
      dirEntries = await readdir(srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory()) {
        await walk(srcPath, destPath);
        continue;
      }
      const absoluteDest = isAbsolute(destPath)
        ? destPath
        : join(process.cwd(), destPath);
      const absoluteSrc = isAbsolute(srcPath)
        ? srcPath
        : join(process.cwd(), srcPath);
      const oldTarget = (await isSymlink(destPath))
        ? await getSymlinkTarget(destPath)
        : null;
      if (copyMode) {
        if (oldTarget !== null) {
          entries.push({
            path: destPath,
            oldTarget,
            newTarget: "(copy)",
            changed: true,
          });
        }
        continue;
      }
      const newTarget = relative(dirname(absoluteDest), absoluteSrc);
      entries.push({
        path: destPath,
        oldTarget,
        newTarget,
        changed: oldTarget !== newTarget,
      });
    }
  }

  await walk(target.scriptsDir, "scripts/dev");
  return entries;
}

/**
 * Copy all templates to .claude/ directory
 */
export async function copyTemplates(
  stack: string,
  tokens?: Record<string, string>,
  options: CopyTemplatesOptions = {},
): Promise<{
  scriptsSymlinked: boolean;
  symlinkResults?: SymlinkResult[];
  /**
   * Destinations skipped because a directory sits in the file's place (#1122).
   * Reported by the caller; nothing was written to them.
   */
  directoryCollisions: string[];
  /**
   * Customizable files that already existed, differed from the rendered
   * template, and were left untouched because `overwriteCustomizable` was not
   * set. Normalized to forward slashes so callers can report them verbatim.
   */
  preservedCustomizable: string[];
}> {
  const templatesDir = getTemplatesDir();

  // Single source of truth for template variables (shared with the diff path)
  const variables = await buildTemplateVariables(stack, tokens, options);

  // `user-owned` destinations skipped on the write path (see copyDir),
  // surfaced to the caller so it can report them without a second diff pass
  // (#814).
  const preservedCustomizable: string[] = [];

  // Destinations a directory occupies. Skipped, not written, and surfaced to
  // the caller so `init` can name them (#1122).
  const directoryCollisions: string[] = [];

  async function copyDir(
    srcDir: string,
    destDir: string,
    copyOptions: { keepExistingFiles?: boolean } = {},
  ): Promise<void> {
    try {
      const entries = await readdir(srcDir, { withFileTypes: true });
      await ensureDir(destDir);

      for (const entry of entries) {
        const srcPath = join(srcDir, entry.name);
        const destPath = join(destDir, entry.name);

        if (entry.isDirectory()) {
          await copyDir(srcPath, destPath, copyOptions);
        } else {
          // A directory in the file's place is skipped, not written: every
          // branch below ends in a `readFile`/`writeFile` that would throw a
          // raw EISDIR and abandon the rest of the tree (#1122).
          if (await isDirectory(destPath)) {
            directoryCollisions.push(destPath.replace(/\\/g, "/"));
            continue;
          }

          // Read, process, and write
          let content = await readFile(srcPath);
          content = processTemplate(content, variables);

          // Protect in-place customizations on the write path, reading the
          // one declared policy rather than a local allow-list. A `user-owned`
          // destination that already exists and differs from the rendered
          // template is preserved unless the caller explicitly opted in via
          // `overwriteCustomizable`. A missing file (fresh install) or an
          // identical one falls through and is written as usual (#814).
          if (
            !options.overwriteCustomizable &&
            ownershipPolicy(destPath) === "user-owned" &&
            (await fileExists(destPath))
          ) {
            const existing = await readFile(destPath);
            if (existing !== content) {
              preservedCustomizable.push(destPath.replace(/\\/g, "/"));
              continue;
            }
          }

          // An existing symlink is replaced, never written through (#1053).
          // `writeFile` now enforces that on its own (#1122), but the branch
          // stays: it is what stops `keepExistingFiles` below from treating a
          // link as "an existing file" and leaving it in place.
          if (await isSymlink(destPath)) {
            await removeFileOrSymlink(destPath);
          } else if (
            copyOptions.keepExistingFiles &&
            (await fileExists(destPath))
          ) {
            continue;
          }

          await writeFile(destPath, content);

          // Make shell scripts executable
          if (entry.name.endsWith(".sh")) {
            await chmod(destPath, 0o755);
          }
        }
      }
    } catch (error) {
      // Skip if source doesn't exist
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  // Copy skills
  await copyDir(join(templatesDir, "skills"), ".claude/skills");

  // Copy agent definitions
  await copyDir(join(templatesDir, "agents"), ".claude/agents");

  // Copy hooks
  await copyDir(join(templatesDir, "hooks"), ".claude/hooks");

  // Copy memory (constitution, etc.)
  await copyDir(join(templatesDir, "memory"), ".claude/memory");

  // Handle scripts directory - use symlinks unless disabled, or unless the
  // resolved target isn't safe to link on every machine (#990 AC-4/AC-5).
  const symlinkTarget = resolveScriptsSymlinkTarget(templatesDir);
  const useSymlinks =
    !options.noSymlinks &&
    !isNativeWindows() &&
    symlinkTarget.mode === "symlink";
  let scriptsSymlinked = false;
  let symlinkResults: SymlinkResult[] | undefined;

  if (
    symlinkTarget.mode === "copy" &&
    !options.noSymlinks &&
    !isNativeWindows()
  ) {
    console.log(`!  ${symlinkTarget.reason}`);
  }

  if (useSymlinks) {
    // Use symlinks for scripts - they don't need template variable processing
    symlinkResults = await symlinkDir(symlinkTarget.scriptsDir, "scripts/dev", {
      force: options.force,
    });

    // Check if any symlinks were actually created (not all fell back to copy)
    scriptsSymlinked = symlinkResults.some(
      (r) => r.created && !r.fallbackToCopy,
    );

    for (const result of symlinkResults) {
      if (result.directoryCollision) {
        directoryCollisions.push(result.path.replace(/\\/g, "/"));
      }
    }
  } else {
    // Fall back to copies (Windows, --no-symlinks, or an unsafe target)
    // Regular files are left alone unless `force` (sync passes it); symlinks
    // are always replaced with a copy (#1053).
    await copyDir(symlinkTarget.scriptsDir, "scripts/dev", {
      keepExistingFiles: !options.force,
    });
  }

  // Copy settings.json
  const settingsPath = join(templatesDir, "settings.json");
  if (await fileExists(settingsPath)) {
    // Written here rather than through `copyDir`, so it needs the same
    // directory guard `copyDir` has (#1122).
    if (await isDirectory(".claude/settings.json")) {
      directoryCollisions.push(".claude/settings.json");
    } else {
      const content = await readFile(settingsPath);
      await writeFile(
        ".claude/settings.json",
        processTemplate(content, variables),
      );
    }
  }

  // Write skills version marker for sync detection
  await writeFile(SKILLS_VERSION_PATH, getPackageVersion());

  return {
    scriptsSymlinked,
    symlinkResults,
    preservedCustomizable,
    directoryCollisions,
  };
}
