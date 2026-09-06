/**
 * Skills-install pre-flight (#713, #988) — warn-only, never mutates.
 *
 * Runs from the CLI's commander `preAction` hook ahead of most commands, and
 * feeds `sequant serve`'s startup report. It classifies the installed
 * `.claude/` tree against the bundled templates and, when the install is
 * stale or drifted, prints a warning that names the fix (`sequant update` /
 * `sequant sync`). Mutation of the project happens only when the user runs
 * one of those commands explicitly.
 *
 * History: until #988 the version-mismatch branch called
 * `syncCommand({ quiet: true })` — a silent, forced template copy. The
 * plugin's MCP config launches `npx sequant@latest serve` with cwd = the open
 * project, so every new Claude Code session after a release rewrote
 * `.claude/hooks/`, `.claude/skills/`, `AGENTS.md`, `scripts/dev/*` and the
 * manifest in the working tree with no output. #713 had already decided that
 * content drift must be warn-only so the pre-flight never clobbers in-place
 * customizations (#711); the same rule now covers version bumps.
 */

import { getManifest } from "../lib/manifest.js";
import { resolveCliInvocation } from "../lib/version-check.js";
import {
  areSkillsOutdated,
  checkAndWarnSkillsOutdated,
  type SkillsOutdatedStatus,
} from "./sync.js";

/**
 * Commands the pre-flight skips entirely.
 *
 * - `init` / `sync` / `update` resolve drift themselves; warning right before
 *   they act would be a circular nag.
 * - `serve`: stdout is the MCP protocol channel, so the pre-flight's
 *   console output would corrupt the stream. `serve` reports install status
 *   on stderr and through the `sequant://config` / `sequant://install`
 *   resources instead (see serve.ts).
 */
export const PREFLIGHT_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  "init",
  "sync",
  "update",
  "serve",
]);

export type VersionPreflightOutcome =
  | "exempt"
  | "no-manifest"
  | "unmanaged"
  | "warned"
  | "clean";

export interface VersionPreflightDeps {
  getManifest: typeof getManifest;
  areSkillsOutdated: typeof areSkillsOutdated;
  /** Reporter for a stale/drifted install. Must not write to the project. */
  warn: (status: SkillsOutdatedStatus) => Promise<boolean>;
}

const defaultDeps: VersionPreflightDeps = {
  getManifest,
  areSkillsOutdated,
  warn: checkAndWarnSkillsOutdated,
};

/**
 * Per-command pre-flight. Read-only by contract: the only side effect is the
 * stat-only drift-fingerprint cache that `areSkillsOutdated({ cache: true })`
 * maintains under `.claude/.sequant/` (a pure optimization, #713 AC-5).
 */
export async function runVersionPreflight(
  cmd: string,
  deps: VersionPreflightDeps = defaultDeps,
): Promise<VersionPreflightOutcome> {
  if (PREFLIGHT_EXEMPT_COMMANDS.has(cmd)) return "exempt";

  const manifest = await deps.getManifest();
  if (!manifest) return "no-manifest";

  const status = await deps.areSkillsOutdated({ cache: true });

  // No version marker → the project manages skills manually; stay silent.
  if (status.currentVersion === null) return "unmanaged";

  if (status.outdated || status.contentDrift > 0) {
    await deps.warn(status);
    return "warned";
  }
  return "clean";
}

/**
 * Install status as exposed by `sequant serve` (stderr line + MCP resources).
 * `null` when the project has no manifest — sequant is not installed here, so
 * there is nothing to be stale.
 */
export interface SkillsInstallStatus {
  /** False when there is no `.sequant-version` marker (skills managed by hand). */
  managed: boolean;
  outdated: boolean;
  currentVersion: string | null;
  packageVersion: string;
  contentDrift: number;
  /** Command that resolves the condition; absent when the install is clean. */
  remediation?: string;
  /** Always true: the server never modifies the project (#988). */
  filesModified: false;
}

export async function getSkillsInstallStatus(
  deps: Pick<VersionPreflightDeps, "getManifest" | "areSkillsOutdated"> = defaultDeps,
): Promise<SkillsInstallStatus | null> {
  const manifest = await deps.getManifest();
  if (!manifest) return null;

  // `cache: false` — the fingerprint cache is a write, and `serve` must stay
  // side-effect-free; the ~15ms scan once per server start is fine.
  const status = await deps.areSkillsOutdated({ cache: false });
  const cli = resolveCliInvocation();
  const managed = status.currentVersion !== null;
  const stale = managed && (status.outdated || status.contentDrift > 0);

  return {
    managed,
    outdated: managed && status.outdated,
    currentVersion: status.currentVersion,
    packageVersion: status.packageVersion,
    contentDrift: status.contentDrift,
    ...(stale ? { remediation: `${cli} update` } : {}),
    filesModified: false,
  };
}

/**
 * One stderr line for `serve` startup, or `null` when there is nothing to say.
 * Says explicitly that nothing was written — the #988 incident was a server
 * start that silently rewrote the tree, so the absence of writes is the news.
 */
export function formatSkillsInstallWarning(
  status: SkillsInstallStatus | null,
): string | null {
  if (!status || !status.managed || !status.remediation) return null;
  const what = status.outdated
    ? `Skills install is stale (${status.currentVersion} → ${status.packageVersion})`
    : `Version current, but ${status.contentDrift} file(s) differ from bundled content`;
  return `!  ${what}. No files were modified. Run: ${status.remediation}`;
}
