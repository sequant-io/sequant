/**
 * Phase registry — single source of truth for workflow phase definitions.
 *
 * Replaces scattered constants (`PHASE_PROMPTS`, `AIDER_PHASE_PROMPTS`,
 * `ISOLATED_PHASES`, `UI_LABELS`, `SECURITY_LABELS`) with a uniform record
 * per phase. All 9 built-in phases register here at module load — no
 * special-casing inside consumer code.
 *
 * Built-in registrations live at the bottom of this file rather than in a
 * separate `built-in-phases.ts` module. The colocated layout follows the
 * existing `drivers/index.ts` pattern and avoids the ESM-cycle pitfall of
 * a separate bootstrap module that re-imports the registry singleton
 * before the singleton is fully initialized.
 *
 * User-extensibility (filesystem discovery of `.sequant/phases/`) is
 * deliberately deferred — see issue #505 descoping comment.
 */

/**
 * Per-driver overrides for a phase. Today only `promptTemplate` is supported;
 * extend the inner record when additional fields need per-driver values.
 */
export interface DriverOverride {
  promptTemplate?: string;
}

/**
 * Retry policy for a single phase. Phases without this field fall back to
 * the global cold-start retry defaults in `phase-executor.ts`. The fields
 * are deliberately optional — a phase only needs to specify what differs.
 */
export interface RetryStrategy {
  /** Override the cold-start retry attempt count for this phase. */
  maxRetries?: number;
  /** Initial backoff in ms before the first retry. */
  backoffMs?: number;
  /** Override the cold-start threshold (seconds). */
  coldStartThreshold?: number;
  /** Extra retries beyond cold-start (e.g. for transient API errors). */
  extraRetries?: number;
}

/**
 * Auto-detection rules consumed by phase-mapper.ts.
 * `labels` is an exact-match list (case-insensitive at the call site).
 */
export interface DetectRules {
  labels?: string[];
}

/**
 * Definition of a workflow phase. Registered at startup via
 * `phaseRegistry.register(...)` and consumed by phase-executor, phase-mapper,
 * and the CLI validator.
 */
export interface PhaseDefinition {
  /** Phase name (matches the skill template directory + CLI `--phases` token). */
  name: string;
  /** Skill template directory under `templates/skills/<skill>/SKILL.md`. */
  skill: string;
  /**
   * Natural-language prompt for the default (Claude Code) driver. The token
   * `{issue}` is substituted with the GitHub issue number at execution time.
   */
  promptTemplate: string;
  /**
   * When true, phase-executor runs this phase inside the issue worktree.
   * `spec`, `verify`, and `merger` run in the main repo (no worktree).
   */
  requiresWorktree: boolean;
  /** Optional per-phase retry overrides. */
  retryStrategy?: RetryStrategy;
  /** Optional auto-detection rules. */
  detect?: DetectRules;
  /**
   * Per-driver overrides. Keyed by agent name (e.g. `"aider"`). When the
   * orchestrator runs a non-Claude driver, the corresponding override's
   * `promptTemplate` (if present) replaces the default.
   */
  driverOverrides?: Record<string, DriverOverride>;
  /**
   * Insertion order hint. Used by phase-mapper to sort label-detected phases
   * into a deterministic pipeline position. Defaults to 0.
   */
  order?: number;
}

/**
 * In-memory registry of phase definitions. Single mutable instance lives
 * in this module — see the exported `phaseRegistry` constant.
 *
 * The class is intentionally minimal (no lifecycle hooks, no async). All
 * mutations happen synchronously at module load by the built-in registrations
 * at the bottom of this file.
 */
export class PhaseRegistry {
  private readonly definitions = new Map<string, PhaseDefinition>();

  /**
   * Register a phase definition. Throws on duplicate names so misconfigured
   * bootstrap modules surface immediately instead of silently overwriting.
   */
  register(definition: PhaseDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(
        `PhaseRegistry: phase "${definition.name}" is already registered`,
      );
    }
    this.definitions.set(definition.name, definition);
  }

  /**
   * Retrieve a phase by name. Throws with a "did you mean" list when the
   * lookup fails — clearer than a downstream "undefined.promptTemplate".
   */
  get(name: string): PhaseDefinition {
    const def = this.definitions.get(name);
    if (!def) {
      const available = this.names().join(", ");
      throw new Error(
        `PhaseRegistry: unknown phase "${name}". Available: ${available}`,
      );
    }
    return def;
  }

  /** True when a phase with this name is registered. */
  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /**
   * All registered phase definitions in insertion order. Insertion order
   * is also the canonical pipeline order (see registrations below).
   */
  list(): PhaseDefinition[] {
    return [...this.definitions.values()];
  }

  /**
   * All registered phase names in insertion order. Replaces the
   * `PhaseSchema.options` array literal exposed by the previous typed-enum
   * `PhaseSchema`.
   */
  names(): string[] {
    return [...this.definitions.keys()];
  }
}

/**
 * Singleton registry instance. All consumer modules (phase-executor,
 * phase-mapper, types.ts, CLI) read from this same instance — there is
 * no second registry.
 */
export const phaseRegistry = new PhaseRegistry();

/**
 * Convenience accessor for the registered phase names. Used by Zod refines,
 * tests, and CLI validation in place of the removed `PhaseSchema.options`.
 */
export function getPhaseNames(): string[] {
  return phaseRegistry.names();
}

// ─── Built-in phase registrations ────────────────────────────────────────
//
// Insertion order below IS the canonical pipeline order — preserved from the
// pre-registry `PhaseSchema` literal (`spec, security-review, exec, testgen,
// test, verify, qa, loop, merger`). Reordering these entries changes the
// order returned by `phaseRegistry.list()` / `getPhaseNames()` and the
// downstream `WORKFLOW_PHASES` constant in `state-schema.ts`.

// Spec — runs in the main repo (planning only, no worktree mutation)
phaseRegistry.register({
  name: "spec",
  skill: "spec",
  promptTemplate:
    "Review GitHub issue #{issue} and create an implementation plan with verification criteria. Run the /spec {issue} workflow.",
  requiresWorktree: false,
  // Spec has a higher transient failure rate (~8.6%) than other phases due
  // to GitHub API issues and rate limits. phase-executor.ts reads these
  // values directly from the registry at module load (see
  // SPEC_RETRY_BACKOFF_MS / SPEC_EXTRA_RETRIES).
  retryStrategy: { extraRetries: 1, backoffMs: 5000 },
  driverOverrides: {
    aider: {
      promptTemplate: `Read GitHub issue #{issue} using 'gh issue view #{issue}'.
Create a spec comment on the issue with:
1. Implementation plan
2. Acceptance criteria as a checklist
3. Risk assessment
Post the comment using 'gh issue comment #{issue} --body "<comment>"'.`,
    },
  },
});

// Security review — worktree-isolated, label-triggered
phaseRegistry.register({
  name: "security-review",
  skill: "security-review",
  promptTemplate:
    "Perform a deep security analysis for GitHub issue #{issue} focusing on auth, permissions, and sensitive operations. Run the /security-review {issue} workflow.",
  requiresWorktree: true,
  detect: {
    labels: ["security", "auth", "authentication", "permissions", "admin"],
  },
  driverOverrides: {
    aider: {
      promptTemplate: `Perform a security review for GitHub issue #{issue}.
Read the issue with 'gh issue view #{issue}'.
Check for auth, permissions, injection, and sensitive data issues.
Post findings as a comment on the issue.`,
    },
  },
});

// Exec — worktree-isolated
phaseRegistry.register({
  name: "exec",
  skill: "exec",
  promptTemplate:
    "Implement the feature for GitHub issue #{issue} following the spec. Run the /exec {issue} workflow.",
  requiresWorktree: true,
  driverOverrides: {
    aider: {
      promptTemplate: `Implement the feature described in GitHub issue #{issue}.
Read the issue and any spec comments with 'gh issue view #{issue} --comments'.
Follow the implementation plan from the spec.
Write tests for new functionality.
Ensure the build passes with 'npm test' and 'npm run build'.`,
    },
  },
});

// Testgen — worktree-isolated
phaseRegistry.register({
  name: "testgen",
  skill: "testgen",
  promptTemplate:
    "Generate test stubs for GitHub issue #{issue} based on the specification. Run the /testgen {issue} workflow.",
  requiresWorktree: true,
  driverOverrides: {
    aider: {
      promptTemplate: `Generate test stubs for GitHub issue #{issue}.
Read the spec comments on the issue with 'gh issue view #{issue} --comments'.
Create test files with describe/it blocks covering the acceptance criteria.
Use the project's existing test framework.`,
    },
  },
});

// Test — worktree-isolated, label-triggered (UI/frontend issues)
phaseRegistry.register({
  name: "test",
  skill: "test",
  promptTemplate:
    "Execute structured browser-based testing for GitHub issue #{issue}. Run the /test {issue} workflow.",
  requiresWorktree: true,
  detect: { labels: ["ui", "frontend", "admin", "web", "browser"] },
  driverOverrides: {
    aider: {
      promptTemplate: `Test the implementation for GitHub issue #{issue}.
Run 'npm test' and verify all tests pass.
Check for edge cases and error handling.`,
    },
  },
});

// Verify — runs in main repo (CLI-only feature verification)
phaseRegistry.register({
  name: "verify",
  skill: "verify",
  promptTemplate:
    "Verify the implementation for GitHub issue #{issue} by running commands and capturing output. Run the /verify {issue} workflow.",
  requiresWorktree: false,
  driverOverrides: {
    aider: {
      promptTemplate: `Verify the implementation for GitHub issue #{issue}.
Run relevant commands and capture their output for review.`,
    },
  },
});

// QA — worktree-isolated
phaseRegistry.register({
  name: "qa",
  skill: "qa",
  promptTemplate:
    "Review the implementation for GitHub issue #{issue} against acceptance criteria. Run the /qa {issue} workflow.",
  requiresWorktree: true,
  driverOverrides: {
    aider: {
      promptTemplate: `Review the changes for GitHub issue #{issue}.
Run 'npm test' and 'npm run build' to verify everything works.
Check each acceptance criterion from the issue comments.
Output a verdict: READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, or AC_NOT_MET
with format "### Verdict: <VERDICT>" followed by an explanation.`,
    },
  },
});

// Loop — worktree-isolated. `maxRetries: 0` encodes the
// "skip cold-start retries" rule consumed by phase-executor.ts (#488).
phaseRegistry.register({
  name: "loop",
  skill: "loop",
  promptTemplate:
    "Parse test/QA findings for GitHub issue #{issue} and iterate until quality gates pass. Run the /loop {issue} workflow.",
  requiresWorktree: true,
  retryStrategy: { maxRetries: 0 },
  driverOverrides: {
    aider: {
      promptTemplate: `Review test and QA findings for GitHub issue #{issue}.
Fix any issues identified in the QA feedback.
Re-run 'npm test' and 'npm run build' until all quality gates pass.`,
    },
  },
});

// Merger — runs in main repo (multi-worktree integration)
phaseRegistry.register({
  name: "merger",
  skill: "merger",
  promptTemplate:
    "Integrate and merge completed worktrees for GitHub issue #{issue}. Run the /merger {issue} workflow.",
  requiresWorktree: false,
  driverOverrides: {
    aider: {
      promptTemplate: `Integrate and merge completed worktrees for GitHub issue #{issue}.
Ensure all branches are up to date and merge cleanly.`,
    },
  },
});
