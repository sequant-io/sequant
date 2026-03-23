/**
 * Repository-level CI configuration loader.
 *
 * Reads .github/sequant.yml (or .sequant/ci.json) for repo-level defaults
 * that are merged with workflow inputs. This lets teams set default agents,
 * phases, and cost controls without editing workflow files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Phase } from "../workflow/types.js";
import { CI_DEFAULTS, type CIConfig } from "./types.js";

const VALID_PHASES = new Set<string>([
  "spec",
  "security-review",
  "testgen",
  "exec",
  "test",
  "qa",
  "loop",
]);

const VALID_AGENTS = new Set(["claude-code", "aider", "codex"]);

/**
 * Load CI configuration from the repository.
 *
 * Checks (in order):
 * 1. .github/sequant.yml (YAML — parsed as simple key: value)
 * 2. .sequant/ci.json (JSON)
 *
 * Returns CI_DEFAULTS if no config file is found.
 */
export function loadCIConfig(repoRoot: string): CIConfig {
  // Try .github/sequant.yml first
  const yamlPath = join(repoRoot, ".github", "sequant.yml");
  const yamlConfig = tryLoadYaml(yamlPath);
  if (yamlConfig) return yamlConfig;

  // Fall back to .sequant/ci.json
  const jsonPath = join(repoRoot, ".sequant", "ci.json");
  const jsonConfig = tryLoadJson(jsonPath);
  if (jsonConfig) return jsonConfig;

  return {};
}

/**
 * Parse a simple YAML config file (key: value, no nested structures).
 * Avoids adding a YAML parser dependency for a simple flat config.
 */
function tryLoadYaml(path: string): CIConfig | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  const parsed: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    parsed[key] = value;
  }

  return normalizeConfig(parsed);
}

/**
 * Load and parse a JSON config file.
 */
function tryLoadJson(path: string): CIConfig | null {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

/**
 * Normalize a raw config object into validated CIConfig.
 */
function normalizeConfig(raw: Record<string, unknown>): CIConfig {
  const config: CIConfig = {};

  if (typeof raw.agent === "string" && VALID_AGENTS.has(raw.agent)) {
    config.agent = raw.agent;
  }

  if (typeof raw.phases === "string") {
    const phases = raw.phases
      .split(",")
      .map((p) => p.trim())
      .filter((p): p is Phase => VALID_PHASES.has(p));
    if (phases.length > 0) config.phases = phases;
  } else if (Array.isArray(raw.phases)) {
    const phases = (raw.phases as unknown[])
      .filter((p): p is string => typeof p === "string")
      .filter((p): p is Phase => VALID_PHASES.has(p));
    if (phases.length > 0) config.phases = phases;
  }

  if (typeof raw.timeout === "number" && raw.timeout >= 60) {
    config.timeout = raw.timeout;
  } else if (typeof raw.timeout === "string") {
    const n = parseInt(raw.timeout, 10);
    if (!isNaN(n) && n >= 60) config.timeout = n;
  }

  if (typeof raw.qualityLoop === "boolean") {
    config.qualityLoop = raw.qualityLoop;
  } else if (typeof raw.qualityLoop === "string") {
    config.qualityLoop = raw.qualityLoop === "true";
  }

  const maxRuns =
    typeof raw.maxConcurrentRuns === "number"
      ? raw.maxConcurrentRuns
      : typeof raw.maxConcurrentRuns === "string"
        ? parseInt(raw.maxConcurrentRuns, 10)
        : NaN;
  if (!isNaN(maxRuns) && maxRuns >= 1) {
    config.maxConcurrentRuns = maxRuns;
  }

  return config;
}

/**
 * Merge config with defaults (for display/documentation purposes).
 */
export function resolveConfig(config: CIConfig): Required<CIConfig> {
  return { ...CI_DEFAULTS, ...config };
}
