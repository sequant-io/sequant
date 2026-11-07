/**
 * Hook channels (#1603): where a checkout's sequant guard hooks come from.
 *
 * Two channels can deliver the same `pre-tool.sh`: the repo (`sequant init`
 * writes `.claude/hooks/*.sh` and registers them in `.claude/settings.json`)
 * and a Claude Code plugin (`hooks/hooks.json` in its install path). Claude
 * Code runs both, so every tool call is guarded twice. This module is the one
 * reader of both; `doctor`, `init`, `update` and `sync` consume it.
 *
 * A plugin counts as a channel only when its resolved install path carries a
 * `hooks/hooks.json` that registers `pre-tool.sh` — never by its name, so a
 * dev plugin with its `hooks/` dir removed is not a second channel (D-1.1).
 * Every read is best-effort: a missing or malformed file means "no channel".
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import type { Manifest } from "./manifest.js";

/** The hook script both channels register. */
const GUARD_SCRIPT = "pre-tool.sh";

/** Project paths the repo channel writes: the scripts and their registration. */
export function isHookChannelPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return p.startsWith(".claude/hooks/") || p === ".claude/settings.json";
}

/**
 * `changes` without the repo hook channel's paths when the manifest records
 * that hooks come from a plugin (`"hooks": "plugin"`), so neither a write nor
 * a drift scan adds back what the install deliberately left out.
 */
export function withoutHookChannel<T extends { path: string }>(
  changes: T[],
  manifest: Pick<Manifest, "hooks"> | null | undefined,
): T[] {
  if (manifest?.hooks !== "plugin") return changes;
  return changes.filter((c) => !isHookChannelPath(c.path));
}

interface PluginHookChannel {
  /** The `enabledPlugins` key, e.g. `sequant@sequant`. */
  id: string;
  installPath: string;
  /** The `hooks/hooks.json` that registers `pre-tool.sh`. */
  hooksJson: string;
}

export interface HookChannels {
  /** `.claude/settings.json` when it registers `pre-tool.sh`, else `null`. */
  repo: string | null;
  plugins: PluginHookChannel[];
}

export interface DetectHookChannelsOptions {
  cwd?: string;
  /**
   * Home directory whose `.claude/` holds the user settings and the plugin
   * registry. Defaults to `$CLAUDE_CONFIG_DIR` when set (Claude Code's own
   * override), otherwise `~/.claude`.
   */
  home?: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a settings-shaped `{ hooks: { Event: [{ hooks: [{ command }] }] } }` runs `pre-tool.sh`. */
function registersGuard(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.hooks)) return false;
  for (const groups of Object.values(config.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (
          isRecord(hook) &&
          typeof hook.command === "string" &&
          hook.command.includes(GUARD_SCRIPT)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * Plugin ids enabled for this checkout. Claude Code merges `enabledPlugins`
 * user < project < local, so a local `false` disables a user `true`.
 */
function enabledPluginIds(claudeDir: string, cwd: string): string[] {
  const merged: Record<string, unknown> = {};
  for (const path of [
    join(claudeDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]) {
    const settings = readJson(path);
    if (isRecord(settings) && isRecord(settings.enabledPlugins)) {
      Object.assign(merged, settings.enabledPlugins);
    }
  }
  return Object.keys(merged).filter((id) => merged[id] === true);
}

/**
 * The install path the registry records for `id` in this checkout: a
 * local/project-scope entry for this project wins over the user-scope entry.
 */
function resolveInstallPath(
  registry: unknown,
  id: string,
  cwd: string,
): string | null {
  if (!isRecord(registry) || !isRecord(registry.plugins)) return null;
  const raw = registry.plugins[id];
  const entries = (Array.isArray(raw) ? raw : [raw]).filter(isRecord);
  const forProject = entries.find(
    (e) =>
      (e.scope === "local" || e.scope === "project") &&
      typeof e.projectPath === "string" &&
      samePath(e.projectPath, cwd),
  );
  const chosen =
    forProject ?? entries.find((e) => e.scope === "user" || !e.scope);
  return chosen && typeof chosen.installPath === "string"
    ? chosen.installPath
    : null;
}

/** Read both hook channels for the checkout at `cwd`. Never throws. */
export function detectHookChannels(
  options: DetectHookChannelsOptions = {},
): HookChannels {
  const cwd = options.cwd ?? process.cwd();
  const claudeDir =
    options.home !== undefined
      ? join(options.home, ".claude")
      : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

  const repoSettings = join(cwd, ".claude", "settings.json");
  const repo = registersGuard(readJson(repoSettings)) ? repoSettings : null;

  const plugins: PluginHookChannel[] = [];
  const ids = enabledPluginIds(claudeDir, cwd);
  if (ids.length > 0) {
    const registry = readJson(
      join(claudeDir, "plugins", "installed_plugins.json"),
    );
    for (const id of ids) {
      const installPath = resolveInstallPath(registry, id, cwd);
      if (!installPath) continue;
      const hooksJson = join(installPath, "hooks", "hooks.json");
      if (existsSync(hooksJson) && registersGuard(readJson(hooksJson))) {
        plugins.push({ id, installPath, hooksJson });
      }
    }
  }

  return { repo, plugins };
}
