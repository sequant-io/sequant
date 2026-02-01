/**
 * Phase Signal Types and Merging
 *
 * Provides types for tracking where phase recommendations come from
 * and logic for merging signals with priority:
 * Labels > Solve Comment > Title > Body
 *
 * @example
 * ```typescript
 * import { PhaseSignal, mergePhaseSignals } from './phase-signal';
 *
 * const signals: PhaseSignal[] = [
 *   { phase: 'test', source: 'label', confidence: 'high' },
 *   { phase: 'test', source: 'title', confidence: 'medium' },
 *   { phase: 'security-review', source: 'body', confidence: 'high' },
 * ];
 *
 * const merged = mergePhaseSignals(signals);
 * // Returns unique phases with highest-priority source for each
 * ```
 */

import type { Phase } from "./workflow/types.js";

/**
 * Source of a phase signal, ordered by priority (highest first)
 */
export type SignalSource = "label" | "solve" | "title" | "body";

/**
 * Priority order for signal sources (higher = takes precedence)
 */
export const SIGNAL_PRIORITY: Record<SignalSource, number> = {
  label: 4, // Highest priority - explicit labels
  solve: 3, // Solve command analysis
  title: 2, // Title keyword detection
  body: 1, // Body pattern detection (lowest)
};

/**
 * Confidence level for a signal
 */
export type SignalConfidence = "high" | "medium" | "low";

/**
 * A phase signal with source tracking
 */
export interface PhaseSignal {
  /** The phase being recommended */
  phase: Phase | "quality-loop";
  /** Where this signal came from */
  source: SignalSource;
  /** Confidence level of the signal */
  confidence: SignalConfidence;
  /** Human-readable reason for this signal */
  reason?: string;
  /** The pattern or keyword that matched (for content signals) */
  match?: string;
}

/**
 * Result of merging phase signals
 */
export interface MergedPhaseResult {
  /** Unique phases to include in workflow */
  phases: Phase[];
  /** Whether quality loop should be enabled */
  qualityLoop: boolean;
  /** Map of phase to the signal that contributed it */
  phaseSignals: Map<Phase | "quality-loop", PhaseSignal>;
  /** All original signals (for debugging/display) */
  allSignals: PhaseSignal[];
}

/**
 * Merge phase signals with priority-based deduplication
 *
 * Priority order: Labels > Solve > Title > Body
 * When multiple signals suggest the same phase, the highest-priority
 * source wins. Signals can only ADD phases, never remove.
 *
 * @param signals - Array of phase signals from various sources
 * @returns Merged result with unique phases and source tracking
 */
export function mergePhaseSignals(signals: PhaseSignal[]): MergedPhaseResult {
  // Map to track the best signal for each phase
  const phaseSignals = new Map<Phase | "quality-loop", PhaseSignal>();

  for (const signal of signals) {
    const existing = phaseSignals.get(signal.phase);

    if (!existing) {
      // First signal for this phase
      phaseSignals.set(signal.phase, signal);
    } else {
      // Compare priorities - higher wins
      const existingPriority = SIGNAL_PRIORITY[existing.source];
      const newPriority = SIGNAL_PRIORITY[signal.source];

      if (newPriority > existingPriority) {
        phaseSignals.set(signal.phase, signal);
      }
      // If same priority, keep the existing one (first wins)
    }
  }

  // Extract phases and quality loop setting
  const phases: Phase[] = [];
  let qualityLoop = false;

  for (const [phase] of phaseSignals) {
    if (phase === "quality-loop") {
      qualityLoop = true;
    } else {
      phases.push(phase);
    }
  }

  return {
    phases,
    qualityLoop,
    phaseSignals,
    allSignals: signals,
  };
}

/**
 * Create a phase signal from a label
 *
 * @param labelName - The GitHub label name
 * @returns Phase signal if the label maps to a phase, null otherwise
 */
export function signalFromLabel(labelName: string): PhaseSignal | null {
  const lowerLabel = labelName.toLowerCase();

  // UI/Frontend labels → test phase
  if (["ui", "frontend", "admin"].includes(lowerLabel)) {
    return {
      phase: "test",
      source: "label",
      confidence: "high",
      reason: `Label '${labelName}' indicates UI work requiring browser testing`,
    };
  }

  // Security labels → security-review phase
  if (["security", "auth", "permissions"].includes(lowerLabel)) {
    return {
      phase: "security-review",
      source: "label",
      confidence: "high",
      reason: `Label '${labelName}' indicates security-sensitive changes`,
    };
  }

  // Complex work labels → quality loop
  if (["complex", "refactor", "breaking", "major"].includes(lowerLabel)) {
    return {
      phase: "quality-loop",
      source: "label",
      confidence: "high",
      reason: `Label '${labelName}' indicates complex work benefiting from quality loop`,
    };
  }

  // Backend labels → no specific phase (but note for test skipping)
  if (["backend", "api", "cli"].includes(lowerLabel)) {
    return null; // Backend work doesn't add phases, but we may skip /test
  }

  return null;
}

/**
 * Create phase signals from an array of labels
 *
 * @param labels - Array of GitHub label names
 * @returns Array of phase signals from labels
 */
export function signalsFromLabels(labels: string[]): PhaseSignal[] {
  const signals: PhaseSignal[] = [];

  for (const label of labels) {
    const signal = signalFromLabel(label);
    if (signal) {
      signals.push(signal);
    }
  }

  return signals;
}

/**
 * Format merged phase result for display
 *
 * @param result - The merged phase result
 * @returns Formatted markdown string
 */
export function formatMergedPhases(result: MergedPhaseResult): string {
  const lines: string[] = [];

  lines.push("## Phase Signal Summary");
  lines.push("");

  if (result.allSignals.length === 0) {
    lines.push("No phase signals detected.");
    return lines.join("\n");
  }

  lines.push("### Signal Sources");
  lines.push("");
  lines.push("| Phase | Source | Confidence | Reason |");
  lines.push("|-------|--------|------------|--------|");

  for (const [phase, signal] of result.phaseSignals) {
    const phaseDisplay =
      phase === "quality-loop" ? "quality-loop" : `/${phase}`;
    const reason = signal.reason || "-";
    lines.push(
      `| ${phaseDisplay} | ${signal.source} | ${signal.confidence} | ${reason} |`,
    );
  }

  lines.push("");
  lines.push("### Final Recommendations");
  lines.push("");

  if (result.phases.length > 0) {
    lines.push(
      `**Phases to add:** ${result.phases.map((p) => `/${p}`).join(", ")}`,
    );
  } else {
    lines.push("**Phases to add:** None");
  }

  if (result.qualityLoop) {
    lines.push("**Quality loop:** Enabled");
  }

  return lines.join("\n");
}
