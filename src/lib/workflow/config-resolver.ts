/**
 * ConfigResolver — 4-layer configuration merge for sequant run.
 *
 * Priority: defaults < settings < env < explicit (CLI flags).
 * Handles Commander.js --no-X boolean negation at the CLI boundary.
 *
 * @module
 */

import {
  type ExecutionConfig,
  type RunOptions,
  DEFAULT_CONFIG,
  DEFAULT_PHASES,
  type Phase,
} from "./types.js";
import type { SequantSettings, ModelRoles } from "../settings.js";
import { DEFAULT_MODEL_ROLES } from "../settings.js";
import { getEnvConfig } from "./batch-executor.js";
import { getPhaseNames } from "./phase-registry.js";

/**
 * Layers for config resolution.
 * Each field is optional — only defined values participate in merging.
 */
export interface ConfigLayers {
  defaults: Record<string, unknown>;
  settings: Record<string, unknown>;
  env: Record<string, unknown>;
  explicit: Record<string, unknown>;
}

/**
 * Coerce an env-var string to the type of the default value.
 * Returns the string as-is if no default exists for type inference.
 */
function coerceEnvValue(value: unknown, defaultValue: unknown): unknown {
  if (typeof value !== "string") return value;
  if (typeof defaultValue === "number") {
    const n = Number(value);
    return isNaN(n) ? value : n;
  }
  if (typeof defaultValue === "boolean") {
    return value === "true";
  }
  return value;
}

/**
 * Generic 4-layer priority merge.
 * For each key across all layers: explicit > env > settings > defaults.
 * Env strings are coerced to match the type of the default value.
 */
export class ConfigResolver {
  private layers: ConfigLayers;

  constructor(layers: ConfigLayers) {
    this.layers = layers;
  }

  /**
   * Resolve all layers into a single merged config object.
   * Priority: explicit > env > settings > defaults.
   */
  resolve(): Record<string, unknown> {
    const { defaults, settings, env, explicit } = this.layers;

    // Collect all keys across layers
    const allKeys = new Set<string>([
      ...Object.keys(defaults),
      ...Object.keys(settings),
      ...Object.keys(env),
      ...Object.keys(explicit),
    ]);

    const result: Record<string, unknown> = {};

    for (const key of allKeys) {
      // Check each layer in reverse priority (lowest first)
      const layers = [
        { value: defaults[key] },
        { value: settings[key] },
        { value: env[key] },
        { value: explicit[key] },
      ];

      // Walk from highest to lowest priority, take first defined value
      let resolved: unknown = undefined;
      const defaultVal: unknown = defaults[key];

      for (const layer of layers) {
        if (layer.value !== undefined) {
          resolved = layer.value;
        }
      }

      // Coerce env values if the winning value came from env layer
      if (
        resolved !== undefined &&
        explicit[key] === undefined &&
        env[key] !== undefined &&
        settings[key] === undefined
      ) {
        // Only env contributed — coerce
        resolved = coerceEnvValue(resolved, defaultVal);
      } else if (
        resolved !== undefined &&
        explicit[key] === undefined &&
        env[key] !== undefined
      ) {
        // env is present and wins over settings — coerce the env value
        resolved = coerceEnvValue(env[key], defaultVal);
      }

      result[key] = resolved;
    }

    return result;
  }
}

/**
 * Commander.js flag mapping for --no-X flags.
 * Commander converts `--no-X` to `{ X: false }` instead of `{ noX: true }`.
 */
interface CommanderRawOptions extends RunOptions {
  log?: boolean;
  smartTests?: boolean;
  mcp?: boolean;
  retry?: boolean;
  rebase?: boolean;
  pr?: boolean;
  /**
   * #804: Commander derives the option key from the FLAG name, so
   * `--auto-wait <minutes>` arrives as `autoWait`, not `autoWaitMinutes`.
   * The flag name is user-facing (and fixed by the issue); the settings key
   * carries its unit per house style (`maxSizeMB`, `durationSeconds`). They
   * therefore cannot match, and without the mapping below the flag parses,
   * shows up in `--help`, and silently does nothing — the #305 failure mode.
   */
  autoWait?: number;
}

/**
 * Normalize Commander.js --no-X flags into RunOptions negation fields.
 * This is a thin adapter at the CLI boundary — not used by programmatic callers.
 */
export function normalizeCommanderOptions(options: RunOptions): RunOptions {
  const raw = options as CommanderRawOptions;
  return {
    ...options,
    ...(raw.log === false && { noLog: true }),
    ...(raw.smartTests === false && { noSmartTests: true }),
    ...(raw.mcp === false && { noMcp: true }),
    ...(raw.retry === false && { noRetry: true }),
    ...(raw.rebase === false && { noRebase: true }),
    ...(raw.pr === false && { noPr: true }),
    // #804: map the flag-derived key onto the interface field. Guarded on
    // `undefined` (not truthiness) so an explicit `--auto-wait 0` still
    // overrides a non-zero setting.
    ...(raw.autoWait !== undefined && { autoWaitMinutes: raw.autoWait }),
  };
}

/**
 * Resolve RunOptions + settings + env into a fully merged RunOptions.
 * This replaces the inline merging logic previously in run.ts.
 */
export function resolveRunOptions(
  cliOptions: RunOptions,
  settings: SequantSettings,
): RunOptions {
  const normalized = normalizeCommanderOptions(cliOptions);
  const envConfig = getEnvConfig();

  // Strip undefined keys so programmatic callers don't clobber env/settings values
  const defined = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== undefined),
  ) as Partial<RunOptions>;

  const merged: RunOptions = {
    // Settings defaults
    sequential: defined.sequential ?? settings.run.sequential,
    concurrency: defined.concurrency ?? settings.run.concurrency,
    timeout: defined.timeout ?? settings.run.timeout,
    logPath: defined.logPath ?? settings.run.logPath,
    qualityLoop: defined.qualityLoop ?? settings.run.qualityLoop,
    maxIterations: defined.maxIterations ?? settings.run.maxIterations,
    noSmartTests: defined.noSmartTests ?? !settings.run.smartTests,
    autoWaitMinutes: defined.autoWaitMinutes ?? settings.run.autoWaitMinutes,
    // Agent settings
    isolateParallel: defined.isolateParallel ?? settings.agents.isolateParallel,
    // Env overrides
    ...envConfig,
    // CLI explicit options override all
    ...defined,
  };

  // Auto-detect phases from labels unless --phases explicitly set
  const autoDetectPhases = !cliOptions.phases && settings.run.autoDetectPhases;
  merged.autoDetectPhases = autoDetectPhases;

  return merged;
}

/**
 * Fall back to `fallback` unless `value` is a usable positive number.
 *
 * `??` alone is not enough for these (#833). `NaN` is not nullish, so a
 * malformed value survives `?? default` and flows on into `setTimeout`, which
 * clamps a `NaN` delay to 0 and aborts the phase on its first tick, or into
 * `while (iteration < maxIterations)`, which is false on entry and runs zero
 * phases. Both read as a phase/agent fault rather than a bad input, which is
 * what makes the silent version expensive. Non-finite and non-positive values
 * therefore fall back *to* the default instead of through it.
 *
 * `bin/cli.ts` rejects these at the flag boundary with a message naming the
 * flag — that is the user-facing fix. This is the structural backstop for
 * programmatic callers, `settings.json`, and whatever calls this next.
 *
 * Exported because `phaseTimeout` has two producers, not one: this module and
 * `commands/ready.ts`, whose value reaches the driver through
 * `ready-gate.ts`'s own `buildPhaseConfig` and never passes through
 * `buildExecutionConfig`. Guarding only here would have left that path open.
 * Chain it to express the layering — CLI, then settings, then the default:
 *
 * ```ts
 * positiveOr(options.timeout, positiveOr(settings.run.timeout, DEFAULT))
 * ```
 */
export function positiveOr(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** A single phase's resolved model/effort override (#914). */
export interface PhasePolicy {
  model?: string;
  effort?: string;
}

/**
 * Parse a `--models`/`--efforts` CLI spec into a phase → value map.
 *
 * Grammar: a bare value (`"sonnet"`) applies to every phase and resolves to
 * `{"*": "sonnet"}`; a comma list of `phase=value` pairs (`"spec=fable,exec=sonnet"`)
 * resolves per phase. Mixing the two forms, an empty phase/value, or an
 * unrecognized phase name all fail fast — this is the CLI boundary, so a
 * malformed spec must never silently resolve to "nothing configured".
 */
export function parsePhaseSpec(
  spec: string,
  phaseNames: string[],
): Record<string, string> {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("Malformed spec: value is empty.");
  }
  if (!trimmed.includes("=")) {
    return { "*": trimmed };
  }

  const result: Record<string, string> = {};
  for (const segment of trimmed.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) {
      throw new Error(
        `Malformed spec segment '${segment}' — expected 'phase=value' (cannot mix a bare value with phase=value pairs).`,
      );
    }
    const phase = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (!phase || !value) {
      throw new Error(
        `Malformed spec segment '${segment}' — both phase and value are required.`,
      );
    }
    if (!phaseNames.includes(phase)) {
      throw new Error(
        `Unknown phase '${phase}'. Available phases: ${phaseNames.join(", ")}.`,
      );
    }
    result[phase] = value;
  }
  return result;
}

/** Apply a parsed phase-spec map onto a policy accumulator for one field. */
function applyPhaseSpec(
  target: Record<string, PhasePolicy>,
  parsed: Record<string, string>,
  field: keyof PhasePolicy,
  phaseNames: string[],
): void {
  const wildcard = parsed["*"];
  if (wildcard !== undefined) {
    for (const phase of phaseNames) {
      target[phase] = { ...target[phase], [field]: wildcard };
    }
    return;
  }
  for (const [phase, value] of Object.entries(parsed)) {
    target[phase] = { ...target[phase], [field]: value };
  }
}

/**
 * Resolve a model-or-role reference to a concrete model string (#975).
 *
 * - No `role:` prefix → returns verbatim (backward compat, AC-3).
 * - `role:<name>` → looks up `<name>` in `modelRoles`.
 *   - Missing entry → throws, naming the role and available keys (AC-2).
 *   - String value → desugars to `{ "claude-code": value }`, picks by `activeDriver`.
 *   - Object value → picks by `activeDriver`; missing driver key → throws.
 * - A role that resolves to a string for a different driver throws (AC-2).
 *
 * @param roleOrString - The model string from config/CLI (may have `role:` prefix).
 * @param modelRoles   - The resolved `run.modelRoles` map.
 * @param activeDriver - Driver registry name (default: `"claude-code"`).
 */
export function resolveRoleToModel(
  roleOrString: string,
  modelRoles: ModelRoles = DEFAULT_MODEL_ROLES,
  activeDriver: string = "claude-code",
): string {
  if (!roleOrString.startsWith("role:")) {
    return roleOrString;
  }

  const roleName = roleOrString.slice("role:".length);
  if (!roleName) {
    throw new Error(
      `Invalid role reference "role:" — role name is empty. Available roles: ${Object.keys(modelRoles).join(", ")}.`,
    );
  }

  const entry = modelRoles[roleName];
  if (entry === undefined) {
    throw new Error(
      `Role "${roleName}" is not defined in run.modelRoles. Available roles: ${Object.keys(modelRoles).join(", ")}.`,
    );
  }

  if (typeof entry === "string") {
    // String shorthand desugars to { "claude-code": value } — only for claude-code.
    if (activeDriver !== "claude-code") {
      throw new Error(
        `Role "${roleName}" uses a string shorthand (claude-code only) but the active driver is "${activeDriver}". Use an object map to define per-driver models.`,
      );
    }
    return entry;
  }

  // Object map: pick by driver.
  const resolved = entry[activeDriver];
  if (resolved === undefined) {
    throw new Error(
      `Role "${roleName}" has no entry for driver "${activeDriver}". Available drivers in this role: ${Object.keys(entry).join(", ")}.`,
    );
  }
  return resolved;
}

/**
 * Resolve per-phase model/effort policies with CLI > settings > absent
 * precedence.
 *
 * This is the single resolver both `buildExecutionConfig` (here) and
 * `ready-gate.ts:buildPhaseConfig` call, so they cannot drift the way the
 * two `phaseTimeout` producers did in #833 — see `positiveOr`'s doc comment
 * for that history.
 */
export function resolvePhasePolicies(
  cliModels: string | undefined,
  cliEfforts: string | undefined,
  settingsPhases: Record<string, PhasePolicy> | undefined,
  phaseNames: string[],
  modelRoles?: ModelRoles,
  activeDriver?: string,
): Record<string, PhasePolicy> {
  const result: Record<string, PhasePolicy> = {};

  // Layer 1 (lowest): settings.run.phases. Skip any phase name settings
  // validation already didn't recognize — that's surfaced as a settings
  // warning at load time (AC-1), not a resolver-time failure.
  if (settingsPhases) {
    for (const [phase, policy] of Object.entries(settingsPhases)) {
      if (!phaseNames.includes(phase)) continue;
      result[phase] = { ...policy };
    }
  }

  // Layer 2 (highest): CLI --models/--efforts. Malformed specs throw here —
  // callers at the CLI boundary (cli-flags.ts) turn that into a fail-fast
  // InvalidArgumentError.
  if (cliModels) {
    applyPhaseSpec(
      result,
      parsePhaseSpec(cliModels, phaseNames),
      "model",
      phaseNames,
    );
  }
  if (cliEfforts) {
    applyPhaseSpec(
      result,
      parsePhaseSpec(cliEfforts, phaseNames),
      "effort",
      phaseNames,
    );
  }

  // Role resolution (#975): resolve any `role:<name>` model references to
  // concrete model strings. Raw strings (no `role:` prefix) pass through
  // verbatim — this is AC-3 backward compat.
  if (modelRoles) {
    for (const [phase, policy] of Object.entries(result)) {
      if (policy.model && policy.model.startsWith("role:")) {
        result[phase] = {
          ...policy,
          model: resolveRoleToModel(policy.model, modelRoles, activeDriver),
        };
      }
    }
  }

  return result;
}

/**
 * Build an ExecutionConfig from merged RunOptions and settings.
 * Extracts the phase-timeout, MCP, retry, and mode resolution logic
 * that was previously inline in run.ts.
 */
export function buildExecutionConfig(
  mergedOptions: RunOptions,
  settings: SequantSettings,
  issueCount: number,
): ExecutionConfig {
  const explicitPhases = mergedOptions.phases
    ? (mergedOptions.phases.split(",").map((p) => p.trim()) as Phase[])
    : null;

  const mcpEnabled = mergedOptions.noMcp
    ? false
    : (settings.run.mcp ?? DEFAULT_CONFIG.mcp);

  const retryEnabled = mergedOptions.noRetry
    ? false
    : (settings.run.retry ?? true);

  const isSequential = mergedOptions.sequential ?? false;
  const isParallel = !isSequential && issueCount > 1;

  // `--no-relay` arrives from Commander as `mergedOptions.relay === false`;
  // explicit `false` overrides settings, otherwise settings/default win.
  const relayEnabled =
    mergedOptions.relay === false ? false : (settings.run.relay ?? true);

  return {
    ...DEFAULT_CONFIG,
    phases: explicitPhases ?? DEFAULT_PHASES,
    sequential: isSequential,
    concurrency: mergedOptions.concurrency ?? DEFAULT_CONFIG.concurrency,
    parallel: isParallel,
    dryRun: mergedOptions.dryRun ?? false,
    verbose: mergedOptions.verbose ?? false,
    // #833: chained so the layering is CLI → settings → default, matching
    // `commands/ready.ts`. A malformed CLI value falls back to the user's
    // configured setting rather than skipping past it to the hardcoded
    // default; a malformed setting falls back to the default. In the normal
    // path `mergedOptions` already carries the settings value, so this only
    // differs when one of the two layers is unusable — which is the case that
    // matters.
    phaseTimeout: positiveOr(
      mergedOptions.timeout,
      positiveOr(settings.run.timeout, DEFAULT_CONFIG.phaseTimeout),
    ),
    qualityLoop: mergedOptions.qualityLoop ?? false,
    maxIterations: positiveOr(
      mergedOptions.maxIterations,
      positiveOr(settings.run.maxIterations, DEFAULT_CONFIG.maxIterations),
    ),
    noSmartTests: mergedOptions.noSmartTests ?? false,
    mcp: mcpEnabled,
    mcpAllowlist: settings.run.mcpAllowlist,
    retry: retryEnabled,
    // #804: default 0 (off) — the whole regression contract for auto-wait is
    // that an unset flag leaves the #761/#799 halt path untouched.
    autoWaitMinutes:
      mergedOptions.autoWaitMinutes ??
      settings.run.autoWaitMinutes ??
      DEFAULT_CONFIG.autoWaitMinutes,
    agent: mergedOptions.agent ?? settings.run.agent,
    aiderSettings: settings.run.aider,
    isolateParallel: mergedOptions.isolateParallel,
    relayEnabled,
    // #817: opt-in only, no settings backing (AC-4). A missing `--ready-gate`
    // resolves to false, keeping the run path byte-identical (AC-5). This is the
    // load-bearing wire the #795 inert-flag class guards against — the flag is
    // useless if it stops reaching the executor here.
    readyGate: mergedOptions.readyGate ?? false,
    // #914: CLI > settings > absent, via the shared resolver both
    // ExecutionConfig producers call (see `resolvePhasePolicies`'s doc
    // comment for the #833 drift this guards against).
    // #975: pass modelRoles + active driver so `role:` prefixes resolve.
    phasePolicies: resolvePhasePolicies(
      mergedOptions.models,
      mergedOptions.efforts,
      settings.run.phases,
      getPhaseNames(),
      settings.run.modelRoles,
      settings.run.agent ?? "claude-code",
    ),
    // #915: CLI > settings > default `false` — mirrors the `readyGate`
    // precedent above. Both `ExecutionConfig` producers (here and
    // `ready-gate.ts:buildPhaseConfig`) resolve this the same way (#833).
    effortEscalation:
      mergedOptions.escalateEffort ?? settings.run.effortEscalation ?? false,
  };
}
