/**
 * Content Analyzer for Phase Detection
 *
 * Analyzes issue title and body content to detect phase-relevant keywords
 * and patterns. This supplements (not replaces) label-based detection.
 *
 * @example
 * ```typescript
 * import { analyzeTitleForPhases, analyzeBodyForPhases, analyzeContentForPhases } from './content-analyzer';
 *
 * const title = "Extract header component from main layout";
 * const body = "Refactor the header.tsx file to create a reusable component...";
 *
 * const signals = analyzeContentForPhases(title, body);
 * // Returns: { phases: ['test'], signals: [...], source: 'content' }
 * ```
 */

import type { Phase } from "./workflow/types.js";

/**
 * A signal detected from content analysis
 */
export interface ContentSignal {
  /** The phase this signal suggests */
  phase: Phase | "quality-loop";
  /** Where the signal was detected */
  source: "title" | "body";
  /** The pattern or keyword that matched */
  pattern: string;
  /** The actual text that matched */
  match: string;
  /** Confidence level of the signal */
  confidence: "high" | "medium" | "low";
  /** Human-readable reason for this signal */
  reason: string;
}

/**
 * Result of content analysis
 */
export interface ContentAnalysisResult {
  /** Phases suggested by content analysis */
  phases: Phase[];
  /** Whether quality loop should be enabled */
  qualityLoop: boolean;
  /** Individual signals detected */
  signals: ContentSignal[];
  /** Notes about the analysis */
  notes: string[];
}

/**
 * Pattern definition for title analysis
 */
interface TitlePattern {
  /** Regex pattern to match */
  pattern: RegExp;
  /** Phase to suggest */
  phase: Phase | "quality-loop";
  /** Confidence level */
  confidence: "high" | "medium" | "low";
  /** Human-readable reason */
  reason: string;
}

/**
 * Pattern definition for body analysis
 */
interface BodyPattern {
  /** Regex pattern to match */
  pattern: RegExp;
  /** Phase to suggest */
  phase: Phase | "quality-loop";
  /** Confidence level */
  confidence: "high" | "medium" | "low";
  /** Human-readable reason */
  reason: string;
}

/**
 * Title keyword patterns for phase detection
 *
 * Based on issue #175 specification:
 * | Pattern | Detection | Suggested Phase |
 * |---------|-----------|-----------------|
 * | `extract`, `component`, `refactor.*ui` | UI work | Add `/test` |
 * | `fix.*unused`, `remove.*variable`, `typo` | Trivial | Note in output |
 * | `auth`, `permission`, `security` | Security-sensitive | Add `/security-review` |
 * | `api`, `endpoint`, `route` | Backend | Skip `/test` |
 */
const TITLE_PATTERNS: TitlePattern[] = [
  // UI work patterns → Add /test
  {
    pattern: /\bextract\b/i,
    phase: "test",
    confidence: "high",
    reason: "Component extraction typically requires UI testing",
  },
  {
    pattern: /\bcomponent\b/i,
    phase: "test",
    confidence: "medium",
    reason: "Component work typically requires UI testing",
  },
  {
    pattern: /\brefactor.*ui\b/i,
    phase: "test",
    confidence: "high",
    reason: "UI refactoring requires browser testing",
  },
  {
    pattern: /\bui\s*(refactor|change|update)\b/i,
    phase: "test",
    confidence: "high",
    reason: "UI changes require browser testing",
  },
  {
    pattern: /\bfrontend\b/i,
    phase: "test",
    confidence: "medium",
    reason: "Frontend work typically requires UI testing",
  },
  {
    pattern: /\bdashboard\b/i,
    phase: "test",
    confidence: "medium",
    reason: "Dashboard changes require browser testing",
  },
  {
    pattern: /\badmin\s*(page|panel|ui)\b/i,
    phase: "test",
    confidence: "medium",
    reason: "Admin UI changes require browser testing",
  },

  // Security-sensitive patterns → Add /security-review
  {
    pattern: /\bauth(entication|orization)?\b/i,
    phase: "security-review",
    confidence: "high",
    reason: "Authentication changes require security review",
  },
  {
    pattern: /\bpermission[s]?\b/i,
    phase: "security-review",
    confidence: "high",
    reason: "Permission changes require security review",
  },
  {
    pattern: /\bsecurity\b/i,
    phase: "security-review",
    confidence: "high",
    reason: "Security-related changes require security review",
  },
  {
    pattern: /\brole[s]?\s*(based|access|control)\b/i,
    phase: "security-review",
    confidence: "high",
    reason: "Role-based access changes require security review",
  },
  {
    pattern: /\baccess\s*control\b/i,
    phase: "security-review",
    confidence: "high",
    reason: "Access control changes require security review",
  },
  {
    pattern: /\btoken[s]?\b/i,
    phase: "security-review",
    confidence: "medium",
    reason: "Token handling may require security review",
  },
  {
    pattern: /\bpassword[s]?\b/i,
    phase: "security-review",
    confidence: "high",
    reason: "Password handling requires security review",
  },
  {
    pattern: /\bcredential[s]?\b/i,
    phase: "security-review",
    confidence: "high",
    reason: "Credential handling requires security review",
  },

  // Complex work patterns → Enable quality loop
  {
    pattern: /\brefactor\b/i,
    phase: "quality-loop",
    confidence: "medium",
    reason: "Refactoring benefits from quality loop iterations",
  },
  {
    pattern: /\bmigrat(e|ion)\b/i,
    phase: "quality-loop",
    confidence: "high",
    reason: "Migrations are complex and benefit from quality loop",
  },
  {
    pattern: /\brestructur(e|ing)\b/i,
    phase: "quality-loop",
    confidence: "high",
    reason: "Restructuring is complex and benefits from quality loop",
  },
  {
    pattern: /\bbreaking\s*change\b/i,
    phase: "quality-loop",
    confidence: "high",
    reason: "Breaking changes require careful quality validation",
  },
];

/**
 * Body content patterns for phase detection
 *
 * Based on issue #175 specification:
 * | Pattern | Detection |
 * |---------|-----------|
 * | References `.tsx` files | UI work likely |
 * | References `scripts/` | CLI work, needs `/verify` |
 * | Contains "breaking change" | Complex, enable quality loop |
 */
const BODY_PATTERNS: BodyPattern[] = [
  // UI work patterns
  {
    pattern: /\.tsx\b/i,
    phase: "test",
    confidence: "medium",
    reason: "References .tsx files indicating React components",
  },
  {
    pattern: /\.jsx\b/i,
    phase: "test",
    confidence: "medium",
    reason: "References .jsx files indicating React components",
  },
  {
    pattern: /\bcomponents?\//i,
    phase: "test",
    confidence: "medium",
    reason: "References components directory",
  },
  {
    pattern: /\bpages?\//i,
    phase: "test",
    confidence: "low",
    reason: "References pages directory (may be UI)",
  },
  {
    pattern: /\bapp\/.*page\.tsx\b/i,
    phase: "test",
    confidence: "high",
    reason: "References Next.js page component",
  },

  // CLI/Script work patterns
  {
    pattern: /\bscripts\//i,
    phase: "exec",
    confidence: "medium",
    reason: "References scripts directory, may need verify phase",
  },
  {
    pattern: /\bbin\//i,
    phase: "exec",
    confidence: "medium",
    reason: "References bin directory, CLI work",
  },
  {
    pattern: /\bcli\b/i,
    phase: "exec",
    confidence: "low",
    reason: "Mentions CLI functionality",
  },

  // Security patterns
  {
    pattern: /\bauth\//i,
    phase: "security-review",
    confidence: "high",
    reason: "References auth directory",
  },
  {
    pattern: /\bmiddleware\.ts\b/i,
    phase: "security-review",
    confidence: "medium",
    reason: "References middleware (often auth-related)",
  },
  {
    pattern: /\brls\s*(polic|rule)/i,
    phase: "security-review",
    confidence: "high",
    reason: "References RLS (Row Level Security)",
  },
  {
    pattern: /\bserver[-_]?action/i,
    phase: "security-review",
    confidence: "medium",
    reason: "Server actions may require security review",
  },

  // Complexity patterns
  {
    pattern: /\bbreaking\s*change\b/i,
    phase: "quality-loop",
    confidence: "high",
    reason: "Breaking change mentioned in body",
  },
  {
    pattern: /\bmajor\s*(refactor|change|update)\b/i,
    phase: "quality-loop",
    confidence: "high",
    reason: "Major changes benefit from quality loop",
  },
  {
    pattern: /\bcomplex\b/i,
    phase: "quality-loop",
    confidence: "low",
    reason: "Complexity mentioned, may benefit from quality loop",
  },
];

/**
 * Trivial work patterns (for noting, not phase changes)
 * These are informational - we note them but don't change phases
 */
const TRIVIAL_PATTERNS: RegExp[] = [
  /\bfix.*unused\b/i,
  /\bremove.*variable\b/i,
  /\btypo\b/i,
  /\btypos\b/i,
  /\bspelling\b/i,
  /\bwhitespace\b/i,
  /\bformat(ting)?\b/i,
  /\blint(ing)?\b/i,
];

/**
 * Analyze issue title for phase-relevant keywords
 *
 * @param title - The issue title
 * @returns Array of detected signals
 */
export function analyzeTitleForPhases(title: string): ContentSignal[] {
  const signals: ContentSignal[] = [];

  for (const { pattern, phase, confidence, reason } of TITLE_PATTERNS) {
    const match = title.match(pattern);
    if (match) {
      signals.push({
        phase,
        source: "title",
        pattern: pattern.source,
        match: match[0],
        confidence,
        reason,
      });
    }
  }

  return signals;
}

/**
 * Analyze issue body for phase-relevant patterns
 *
 * @param body - The issue body
 * @returns Array of detected signals
 */
export function analyzeBodyForPhases(body: string): ContentSignal[] {
  const signals: ContentSignal[] = [];

  for (const { pattern, phase, confidence, reason } of BODY_PATTERNS) {
    const match = body.match(pattern);
    if (match) {
      signals.push({
        phase,
        source: "body",
        pattern: pattern.source,
        match: match[0],
        confidence,
        reason,
      });
    }
  }

  return signals;
}

/**
 * Check if content indicates trivial work
 *
 * @param title - The issue title
 * @param body - The issue body
 * @returns True if the work appears trivial
 */
export function isTrivialWork(title: string, body: string): boolean {
  const combined = `${title}\n${body}`;

  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(combined)) {
      return true;
    }
  }

  return false;
}

/**
 * Analyze issue content (title + body) for phase recommendations
 *
 * This is the main entry point for content analysis.
 * It analyzes both title and body, deduplicates signals,
 * and returns a consolidated result.
 *
 * @param title - The issue title
 * @param body - The issue body
 * @returns Consolidated analysis result with phases and signals
 */
export function analyzeContentForPhases(
  title: string,
  body: string,
): ContentAnalysisResult {
  const titleSignals = analyzeTitleForPhases(title);
  const bodySignals = analyzeBodyForPhases(body);

  // Combine all signals
  const allSignals = [...titleSignals, ...bodySignals];

  // Deduplicate phases (keep highest confidence signal for each phase)
  const phaseMap = new Map<
    Phase | "quality-loop",
    { signal: ContentSignal; confidence: number }
  >();
  const confidenceRank: Record<string, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  for (const signal of allSignals) {
    const existing = phaseMap.get(signal.phase);
    const currentRank = confidenceRank[signal.confidence];

    if (!existing || currentRank > existing.confidence) {
      phaseMap.set(signal.phase, { signal, confidence: currentRank });
    }
  }

  // Extract phases and quality loop setting
  const phases: Phase[] = [];
  let qualityLoop = false;

  for (const [phase] of phaseMap) {
    if (phase === "quality-loop") {
      qualityLoop = true;
    } else {
      phases.push(phase);
    }
  }

  // Build notes
  const notes: string[] = [];

  if (isTrivialWork(title, body)) {
    notes.push("Trivial work detected - may not require full workflow");
  }

  if (phases.includes("test")) {
    notes.push("UI/component work detected - browser testing recommended");
  }

  if (phases.includes("security-review")) {
    notes.push(
      "Security-sensitive content detected - security review recommended",
    );
  }

  if (qualityLoop) {
    notes.push("Complex work detected - quality loop recommended");
  }

  if (allSignals.length === 0) {
    notes.push("No phase signals detected from content analysis");
  }

  return {
    phases,
    qualityLoop,
    signals: allSignals,
    notes,
  };
}

/**
 * Format content analysis result for display
 *
 * @param result - The analysis result
 * @returns Formatted markdown string
 */
export function formatContentAnalysis(result: ContentAnalysisResult): string {
  const lines: string[] = [];

  lines.push("## Content Analysis");
  lines.push("");

  if (result.signals.length === 0) {
    lines.push("No phase-relevant patterns detected in title or body.");
    return lines.join("\n");
  }

  lines.push("### Detected Signals");
  lines.push("");
  lines.push("| Source | Pattern | Match | Phase | Confidence | Reason |");
  lines.push("|--------|---------|-------|-------|------------|--------|");

  for (const signal of result.signals) {
    const phaseDisplay =
      signal.phase === "quality-loop" ? "quality-loop" : `/${signal.phase}`;
    lines.push(
      `| ${signal.source} | \`${signal.pattern}\` | "${signal.match}" | ${phaseDisplay} | ${signal.confidence} | ${signal.reason} |`,
    );
  }

  lines.push("");

  if (result.phases.length > 0 || result.qualityLoop) {
    lines.push("### Recommendations");
    lines.push("");

    if (result.phases.length > 0) {
      lines.push(
        `**Additional phases:** ${result.phases.map((p) => `/${p}`).join(", ")}`,
      );
    }

    if (result.qualityLoop) {
      lines.push("**Quality loop:** Recommended based on content complexity");
    }
  }

  if (result.notes.length > 0) {
    lines.push("");
    lines.push("### Notes");
    lines.push("");
    for (const note of result.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}
