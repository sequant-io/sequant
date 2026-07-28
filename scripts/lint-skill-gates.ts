#!/usr/bin/env npx tsx
/**
 * Lint a skill's own verdict-enforcement chain for unreachable gates.
 *
 * `/qa` has ~15 conditional sections that each self-report a status string, and
 * its §7 verdict algorithm aggregates them **by name**. Nothing checked that the
 * set of sections and the set of gates agreed, so a section could declare any
 * enforcement it liked in prose and §7 would silently not implement it.
 *
 * That is not hypothetical: §2h's `CRITICAL: ... verdict CANNOT be
 * READY_FOR_MERGE` gate was unreachable from the day it shipped (no
 * `cli_registration_status` in §7 step 2, no branch in step 4), and #819's §6f
 * Trust-Boundary Check shipped with the same defect — caught by a human second
 * pass in #830, missed by the automated `/qa` pass that reviewed the same
 * commit. This script is the deterministic replacement for that second pass.
 *
 * Four invariants (see #834):
 *
 *   I1  A section declaring a verdict floor has a status token in §7 step 2
 *       that attributes back to it AND a branch on that token in step 4.
 *   I2  Every status token in §7 step 2 attributes to a section that exists.
 *   I3  Every section headed `(REQUIRED` that declares an output section
 *       appears in the Standard required-sections checklist, and in either the
 *       Simple Fix checklist or Simple Fix's explicit omitted list.
 *   I4  Output-template sections and required-sections checklist entries agree
 *       in both directions, per mode.
 *
 * Skills with no verdict algorithm are reported as skipped, not failed — today
 * `qa` is the only skill that has one.
 *
 * Usage:
 *   npx tsx scripts/lint-skill-gates.ts          # Scan and report
 *
 * Exit codes:
 *   0 - No violations
 *   1 - Violations found
 *
 * Background: #834. Motivating defects: §2h (unwired since it shipped), #819
 * F1 (§6f floor with no §7 gate), #819 F2 (§6f routed only through §6d, which
 * Simple Fix mode omits). Related: #22 / #823 (four validation layers
 * specified, only Layer 1 shipped — this is Layer 2 for `/qa`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

/**
 * Skill roots, in priority order. Only the FIRST one that exists is scanned.
 *
 * Unlike `lint-skill-calls.ts` (which scans all three because a
 * runtime-dangerous call in any copy is a live hazard), scanning the mirrors
 * here would report every violation three times. `.claude/skills` is canonical
 * and `lint:skill-sync` already fails the build on mirror drift, so linting
 * the canonical copy is sufficient. Consumer projects installed via
 * `sequant init` have `.claude/skills` too; the later entries are fallbacks
 * for a repo layout that ships only a mirror.
 */
const SCAN_ROOTS = [".claude/skills", "templates/skills", "skills"];

/** Marker that identifies a skill as having a verdict algorithm at all. */
const ALGORITHM_MARKER = "Verdict Determination Algorithm";

/**
 * Phrases by which a section declares that it can floor or cap the verdict.
 *
 * The first three are #834's I1 list verbatim. `verdict floors at` is a fourth
 * addition: §6e phrases its (correctly wired) floor that way, so without it a
 * section could declare a floor in §6e's style and escape I1 entirely. Adding
 * a phrase can only widen what I1 checks — it cannot make a wired section fail.
 */
const VERDICT_FLOOR_PHRASES = [
  "floor the verdict at",
  "verdict cannot be",
  "maximum verdict",
  "verdict floors at",
];

/**
 * Checklist-label → template-header aliases, applied after normalization.
 *
 * Each entry is a place where the Output Verification checklist and the Output
 * Template legitimately word the same section differently. They are aliases,
 * not suppressions: both sides must still be present, I4 just accepts the two
 * spellings as the same section. If this map grows past a handful the right fix
 * is renaming the headers so they match, not adding entries.
 */
const SECTION_ALIASES: Readonly<Record<string, string>> = {
  // Checklist says "Findings" because it also demands strengths/issues/suggestions;
  // the template header is the shorter "Code Review".
  "code review findings": "code review",
  // Checklist names the enforcement rule; the template names the output table.
  "manual test ac enforcement": "manual test acs",
  // Checklist phrases it as an action ("Check"); the template as a section.
  "documentation check": "documentation",
};

export type InvariantId = "I1" | "I2" | "I3" | "I4";

export interface Violation {
  /** Which invariant failed, or a parse failure. */
  invariant: InvariantId | "PARSE";
  /** Section id (e.g. "2h") or checklist/template mode this concerns. */
  subject: string;
  /** 1-indexed line in the scanned file, when known. */
  line?: number;
  /** What is wrong and what wiring is missing. */
  message: string;
}

export interface FileViolation extends Violation {
  file: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface Section {
  /** Section number as written, e.g. "2h", "7", "0b". */
  id: string;
  /** Heading text after the number, e.g. "CLI Registration Verification (When ...)". */
  title: string;
  /** 1-indexed line of the heading. */
  line: number;
  /** Section body, heading excluded. */
  body: string;
}

// `### 2h. Title` / `### 7. Title` / `### 10a. Title`
const NUMBERED_HEADING_RE = /^### (\d+[a-z]?)\.\s+(.*)$/;
// `### Phase 0b: Title`
const PHASE_HEADING_RE = /^### Phase (\d+[a-z]?):\s+(.*)$/;

/**
 * True for a fence delimiter at column 0.
 *
 * Only column-0 fences are honored. Skill markdown nests fenced blocks inside
 * numbered list items (e.g. §2h's remediation block puts a ```typescript fence
 * inside an indented ```markdown one); tracking those would desynchronize the
 * toggle. Every fence that actually shields a `##`/`###` line from being read
 * as a real heading is at column 0.
 */
function isFenceDelimiter(line: string): boolean {
  return line.startsWith("```");
}

/**
 * Extract every numbered check section (`### N[a]. Title`, `### Phase N[a]: Title`).
 *
 * Headings inside fenced blocks are ignored, so the `## QA Review for Issue #<N>`
 * lines inside output templates do not truncate the section they live in.
 */
export function parseSections(content: string): Section[] {
  const lines = content.split("\n");
  const starts: Array<{ id: string; title: string; index: number }> = [];
  /** Any heading at all — used to bound a section's body. */
  const boundaries: number[] = [];

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.startsWith("## ") && !line.startsWith("### ")) continue;

    boundaries.push(i);
    const numbered = NUMBERED_HEADING_RE.exec(line);
    if (numbered) {
      starts.push({ id: numbered[1], title: numbered[2], index: i });
      continue;
    }
    const phase = PHASE_HEADING_RE.exec(line);
    if (phase) {
      starts.push({ id: phase[1], title: phase[2], index: i });
    }
  }

  return starts.map(({ id, title, index }) => {
    const next = boundaries.find((b) => b > index) ?? lines.length;
    return {
      id,
      title,
      line: index + 1,
      body: lines.slice(index + 1, next).join("\n"),
    };
  });
}

/**
 * The `### Name` header of the output section a check section declares.
 *
 * Read from the section's first column-0 ```markdown fence. Returns null when
 * the section declares no output section — §4 (Failure Path & Edge Case
 * Testing) and §6 (Execution Evidence) are analysis instructions with no
 * output block, and a section with no output section cannot be listed in an
 * output checklist. That is why I3 needs no allowlist for them.
 */
export function parseDeclaredOutputName(section: Section): string | null {
  const lines = section.body.split("\n");
  let inMarkdownFence = false;
  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      // Entering a markdown fence, or leaving whichever fence we were in.
      inMarkdownFence = !inMarkdownFence && line.trim() === "```markdown";
      continue;
    }
    if (inMarkdownFence && line.startsWith("### ")) {
      return line.slice(4).trim();
    }
  }
  return null;
}

export interface VerdictAlgorithm {
  /** step-2 status token → the section id it is attributed to. */
  step2Tokens: Map<string, string>;
  /** step-2 tokens that appear in a step-4 `IF` / `ELSE IF` condition. */
  step4Tokens: Set<string>;
  /** 1-indexed line of the algorithm block, for error messages. */
  line: number;
}

const STEP_HEADING_RE = /^(\d+[a-z]?)\.\s/;
const TOKEN_DEFINITION_RE = /^\s*-\s+([a-z_][a-z0-9_]*)\s*=/;
const SECTION_ATTRIBUTION_RE = /\b(?:Section|Phase)\s+(\d+[a-z]?)\b/;
const BRANCH_LINE_RE = /^\s*-\s+(?:ELSE\s+)?IF\b/;

/**
 * Parse §7's verdict algorithm into its step-2 gate list and step-4 branches.
 *
 * Returns null when the skill has no verdict algorithm at all (the common case
 * — only `qa` has one), which callers treat as "skip this file", not "pass".
 */
export function parseVerdictAlgorithm(
  content: string,
): VerdictAlgorithm | null {
  const lines = content.split("\n");
  const markerIndex = lines.findIndex((l) => l.includes(ALGORITHM_MARKER));
  if (markerIndex === -1) return null;

  // The algorithm lives in the first fenced block after the marker.
  let start = -1;
  for (let i = markerIndex; i < lines.length; i++) {
    if (isFenceDelimiter(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return {
      step2Tokens: new Map(),
      step4Tokens: new Set(),
      line: markerIndex + 1,
    };
  }
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (isFenceDelimiter(lines[i])) {
      end = i;
      break;
    }
  }

  const step2Tokens = new Map<string, string>();
  const step4Tokens = new Set<string>();
  const step4Lines: string[] = [];
  let step: string | null = null;

  for (let i = start; i < end; i++) {
    const line = lines[i];
    const heading = STEP_HEADING_RE.exec(line);
    if (heading) {
      step = heading[1];
      continue;
    }
    if (step === "2") {
      const def = TOKEN_DEFINITION_RE.exec(line);
      if (def) {
        const attribution = SECTION_ATTRIBUTION_RE.exec(line);
        step2Tokens.set(def[1], attribution ? attribution[1] : "");
      }
      continue;
    }
    if (step === "4" && BRANCH_LINE_RE.test(line)) {
      step4Lines.push(line);
    }
  }

  for (const token of step2Tokens.keys()) {
    const wordRe = new RegExp(`\\b${token}\\b`);
    if (step4Lines.some((l) => wordRe.test(l))) step4Tokens.add(token);
  }

  return { step2Tokens, step4Tokens, line: markerIndex + 1 };
}

export interface Checklists {
  standard: string[];
  simpleFixRequired: string[];
  simpleFixOmitted: string[];
  /** True when the `## Output Verification` region exists at all. */
  found: boolean;
}

const CHECKLIST_ITEM_RE = /^-\s+\[[ x]\]\s+\*\*(.+?)\*\*/;
const PLAIN_BULLET_RE = /^-\s+(?!\[)(.+)$/;

/**
 * Parse the `## Output Verification` region's per-mode required-section lists
 * and Simple Fix's explicit omitted list.
 *
 * Only `- [ ] **Name**` entries count as checklist entries; prose bullets
 * without a bolded section name (e.g. Simple Fix's trailing "Adversarial
 * re-read of core logic — list anything the structured pipeline didn't
 * surface") are guidance, not section declarations.
 */
export function parseChecklists(content: string): Checklists {
  const lines = content.split("\n");
  const startIndex = lines.findIndex(
    (l) => l.trim() === "## Output Verification",
  );
  const result: Checklists = {
    standard: [],
    simpleFixRequired: [],
    simpleFixOmitted: [],
    found: startIndex !== -1,
  };
  if (startIndex === -1) return result;

  let mode: "simple" | "standard" | "other" = "other";
  /** Inside Simple Fix, plain bullets are the omitted list until this flips. */
  let simpleFixRequiredStarted = false;
  let inFence = false;

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("## ")) break;
    if (line.startsWith("### ")) {
      const heading = line.slice(4);
      if (heading.startsWith("Simple Fix Mode")) {
        mode = "simple";
        simpleFixRequiredStarted = false;
      } else if (heading.startsWith("Standard QA")) {
        mode = "standard";
      } else {
        mode = "other";
      }
      continue;
    }
    if (line.includes("Required sections for simple fix mode")) {
      simpleFixRequiredStarted = true;
      continue;
    }

    const item = CHECKLIST_ITEM_RE.exec(line);
    if (item) {
      if (mode === "standard") result.standard.push(item[1].trim());
      else if (mode === "simple") result.simpleFixRequired.push(item[1].trim());
      continue;
    }
    if (mode === "simple" && !simpleFixRequiredStarted) {
      const bullet = PLAIN_BULLET_RE.exec(line);
      if (bullet) result.simpleFixOmitted.push(bullet[1].trim());
    }
  }

  return result;
}

export interface Templates {
  standard: string[];
  simpleFix: string[];
  /** True when the `## Output Template` region exists at all. */
  found: boolean;
}

/**
 * Parse the `### Name` headers inside each output template's markdown fence.
 */
export function parseTemplateSections(content: string): Templates {
  const lines = content.split("\n");
  const startIndex = lines.findIndex((l) => l.trim() === "## Output Template");
  const result: Templates = {
    standard: [],
    simpleFix: [],
    found: startIndex !== -1,
  };
  if (startIndex === -1) return result;

  let mode: "simple" | "standard" | "other" = "other";
  let inFence = false;

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      if (line.startsWith("## ")) break;
      if (line.startsWith("### ")) {
        const heading = line.slice(4);
        if (heading.startsWith("Simple Fix Template")) mode = "simple";
        else if (heading.startsWith("Standard Template")) mode = "standard";
        else mode = "other";
      }
      continue;
    }
    if (!line.startsWith("### ")) continue;
    const name = line.slice(4).trim();
    if (mode === "standard") result.standard.push(name);
    else if (mode === "simple") result.simpleFix.push(name);
  }

  return result;
}

/** Anchor for §7's Manual Test AC Enforcement detection pattern. */
const MANUAL_TEST_ANCHOR = 'manual_test_acs=$(echo "$spec_comment"';
/** Anchor for the awk pass that attributes those matches to AC IDs. */
const MANUAL_AC_ID_ANCHOR = 'manual_ac_ids=$(echo "$spec_comment"';
/** Anchor for the step-3a gate that consumes both. */
const STEP_3A_ANCHOR = "Manual test AC enforcement check";

/**
 * Compile §7's AC-ID attribution pattern — the second `awk` half of Manual Test
 * AC Enforcement.
 *
 * Detection is two passes: `grep` finds the lines, `awk` walks back to the
 * nearest `AC-N` header to say *which* AC each line belongs to. Both carry the
 * same term list, so both must be kept in step; mutation testing showed that
 * gating only the `grep` half let the `awk` half be stripped with a green
 * suite, leaving attribution silently broken.
 *
 * Extracts the awk program's second `/.../` block. Compiled case-insensitively
 * to match the program's own `BEGIN{IGNORECASE=1}`.
 */
export function parseEvidenceAcIdPattern(content: string): RegExp | null {
  const anchor = content.indexOf(MANUAL_AC_ID_ANCHOR);
  if (anchor === -1) return null;
  const region = content.slice(anchor, anchor + 600);
  const match = /\{ac=\$0\}\s*\/(.+?)\/\{print ac\}/.exec(region);
  if (!match) return null;
  try {
    return new RegExp(match[1], "i");
  } catch {
    return null;
  }
}

/**
 * Compile §7's live Manual Test AC Enforcement detection pattern.
 *
 * The pattern lives in SKILL.md as a `grep -iE '(...)'` and is the single
 * source of truth. Reading it back rather than restating it anywhere means
 * weakening the shipped pattern is detectable — `lintSkillContent` fails loud
 * when step 3a declares this enforcement but the pattern cannot be compiled,
 * and the test suite asserts the compiled pattern still matches the evidence
 * phrasings it is supposed to catch (#819 AC-4).
 *
 * Scoped to the `manual_test_acs=` assignment so an unrelated `grep -iE`
 * elsewhere in the file cannot satisfy it. Returns null when the skill has no
 * such block.
 */
export function parseEvidenceAcPattern(content: string): RegExp | null {
  const anchor = content.indexOf(MANUAL_TEST_ANCHOR);
  if (anchor === -1) return null;
  const region = content.slice(anchor, anchor + 600);
  const match = /grep -iE '\((.+?)\)'/.exec(region);
  if (!match) return null;
  try {
    return new RegExp(match[1], "i");
  } catch {
    // An ERE that JavaScript cannot compile is a real problem worth surfacing,
    // not something to swallow into a silent null.
    return null;
  }
}

/**
 * Normalize a section name for cross-list comparison.
 *
 * Strips the placeholder tail from headers like
 * `Verdict: [READY_FOR_MERGE | ...]`, collapses whitespace, lowercases, then
 * applies SECTION_ALIASES.
 */
export function canonicalizeSectionName(name: string): string {
  const stripped = name
    .replace(/\s*:\s*\[.*$/, "")
    .replace(/\s*:\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return SECTION_ALIASES[stripped] ?? stripped;
}

function canonSet(names: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of names) map.set(canonicalizeSectionName(n), n);
  return map;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function declaresVerdictFloor(section: Section): string | null {
  const lower = section.body.toLowerCase();
  for (const phrase of VERDICT_FLOOR_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * I1 — a section declaring a verdict floor must be reachable from §7.
 *
 * Deliberately asks §7 rather than the section: a token is looked up by the
 * section it is *attributed to* in step 2, not by name-shape. A name-shape
 * heuristic (`[a-z_]+_status`) would false-positive on §6a, whose real token is
 * `skill_verification`.
 *
 * The section holding the algorithm itself is exempt — it is the aggregator,
 * and its branch comments naturally quote the floor phrases.
 */
export function checkI1(
  sections: Section[],
  algorithm: VerdictAlgorithm,
  algorithmSectionId: string | null,
): Violation[] {
  const violations: Violation[] = [];
  for (const section of sections) {
    if (section.id === algorithmSectionId) continue;
    const phrase = declaresVerdictFloor(section);
    if (!phrase) continue;

    const attributed = [...algorithm.step2Tokens.entries()]
      .filter(([, ref]) => ref === section.id)
      .map(([token]) => token);

    if (attributed.length === 0) {
      violations.push({
        invariant: "I1",
        subject: `§${section.id}`,
        line: section.line,
        message:
          `§${section.id} (${section.title}) declares a verdict floor ("${phrase}") but no §7 ` +
          `step-2 status token is attributed to Section ${section.id}. The gate can never fire. ` +
          `Add a token to §7 step 2 ("… = status from Section ${section.id} (…)") and branch on ` +
          `it in step 4, mirroring §6f/trust_boundary_status.`,
      });
      continue;
    }
    const branched = attributed.filter((t) => algorithm.step4Tokens.has(t));
    if (branched.length === 0) {
      violations.push({
        invariant: "I1",
        subject: `§${section.id}`,
        line: section.line,
        message:
          `§${section.id} (${section.title}) declares a verdict floor ("${phrase}") and §7 step 2 ` +
          `declares ${attributed.map((t) => `\`${t}\``).join(", ")}, but step 4 never branches on ` +
          `it. Add an "ELSE IF ${attributed[0]} == …: → <verdict>" branch to §7 step 4.`,
      });
    }
  }
  return violations;
}

/**
 * I2 — every §7 step-2 token must attribute to a section that exists.
 */
export function checkI2(
  sections: Section[],
  algorithm: VerdictAlgorithm,
): Violation[] {
  const violations: Violation[] = [];
  const known = new Set(sections.map((s) => s.id));
  for (const [token, ref] of algorithm.step2Tokens) {
    if (ref === "") {
      violations.push({
        invariant: "I2",
        subject: token,
        line: algorithm.line,
        message:
          `§7 step 2 declares \`${token}\` without naming the section that produces it. ` +
          `Add "status from Section <N>" so the gate is traceable to a section that defines its outcomes.`,
      });
      continue;
    }
    if (!known.has(ref)) {
      violations.push({
        invariant: "I2",
        subject: token,
        line: algorithm.line,
        message:
          `§7 step 2 attributes \`${token}\` to Section ${ref}, which does not exist. ` +
          `Orphan gate: either add the section or remove the token.`,
      });
    }
  }
  return violations;
}

/**
 * I3 — a `(REQUIRED` section that declares an output section must have an
 * explicit place in both mode checklists.
 *
 * Standard: it must be in the required-sections checklist. Simple Fix: it must
 * be either required or explicitly omitted — silence is the #819 F2 defect,
 * where a required security check was reachable only through a section Simple
 * Fix mode omits, switching it off below the size gate.
 */
export function checkI3(
  sections: Section[],
  checklists: Checklists,
): Violation[] {
  const violations: Violation[] = [];
  const standard = canonSet(checklists.standard);
  const simpleRequired = canonSet(checklists.simpleFixRequired);
  const simpleOmitted = canonSet(checklists.simpleFixOmitted);

  for (const section of sections) {
    if (!section.title.includes("(REQUIRED")) continue;
    const outputName = parseDeclaredOutputName(section);
    if (outputName === null) continue;
    const key = canonicalizeSectionName(outputName);

    if (!standard.has(key)) {
      violations.push({
        invariant: "I3",
        subject: `§${section.id}`,
        line: section.line,
        message:
          `§${section.id} (${section.title}) is REQUIRED and declares output section ` +
          `"${outputName}", but it is missing from the Standard required-sections checklist. ` +
          `Add "- [ ] **${outputName}** - …" under "### Standard QA".`,
      });
    }
    if (!simpleRequired.has(key) && !simpleOmitted.has(key)) {
      violations.push({
        invariant: "I3",
        subject: `§${section.id}`,
        line: section.line,
        message:
          `§${section.id} (${section.title}) is REQUIRED and declares output section ` +
          `"${outputName}", but Simple Fix mode neither requires nor explicitly omits it. ` +
          `Add it to the Simple Fix required list, or to the omitted list if it genuinely ` +
          `should not run below the size gate — silence here is how #819 F2 shipped.`,
      });
    }
  }
  return violations;
}

/**
 * I4 — checklist entries and template sections must agree, both directions.
 *
 * A template section with no checklist entry is a section nothing verifies was
 * produced (#819 F1's missing template section, inverted). A checklist entry
 * with no template section is a demand the template gives no place to satisfy.
 */
export function checkI4(
  checklists: Checklists,
  templates: Templates,
): Violation[] {
  const violations: Violation[] = [];

  const modes: Array<{
    label: string;
    checklist: string[];
    template: string[];
    checklistHeading: string;
    templateHeading: string;
  }> = [
    {
      label: "Standard",
      checklist: checklists.standard,
      template: templates.standard,
      checklistHeading: '"### Standard QA" checklist',
      templateHeading: '"### Standard Template"',
    },
    {
      label: "Simple Fix",
      checklist: checklists.simpleFixRequired,
      template: templates.simpleFix,
      checklistHeading: '"### Simple Fix Mode" required list',
      templateHeading: '"### Simple Fix Template"',
    },
  ];

  for (const mode of modes) {
    const checklist = canonSet(mode.checklist);
    const template = canonSet(mode.template);

    for (const [key, original] of template) {
      if (checklist.has(key)) continue;
      violations.push({
        invariant: "I4",
        subject: `${mode.label} template`,
        message:
          `${mode.templateHeading} has section "${original}" with no matching entry in ` +
          `${mode.checklistHeading}. Nothing verifies it was produced — add ` +
          `"- [ ] **${original}** - …" to the checklist.`,
      });
    }
    for (const [key, original] of checklist) {
      if (template.has(key)) continue;
      violations.push({
        invariant: "I4",
        subject: `${mode.label} checklist`,
        message:
          `${mode.checklistHeading} requires "${original}" but ${mode.templateHeading} has no ` +
          `such section. Add the section to the template, or drop the checklist entry.`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Per-file driver
// ---------------------------------------------------------------------------

export interface FileResult {
  /** True when the file has no verdict algorithm and was skipped (AC-5). */
  skipped: boolean;
  violations: Violation[];
}

/**
 * Run all four invariants over one skill's markdown content.
 *
 * Fails LOUD on unparseable structure: a region that is present but yields no
 * entries is reported as a PARSE violation, never as "no findings". A parser
 * that silently returns empty would make this whole lint a tautology — the
 * exact failure mode #834 exists to stop.
 */
export function lintSkillContent(content: string): FileResult {
  const algorithm = parseVerdictAlgorithm(content);
  if (!algorithm) return { skipped: true, violations: [] };

  const violations: Violation[] = [];
  const sections = parseSections(content);

  if (sections.length === 0) {
    violations.push({
      invariant: "PARSE",
      subject: "sections",
      message:
        "File has a verdict algorithm but no `### N. Title` check sections could be parsed. " +
        "Section headings changed shape — update parseSections() rather than leaving the lint blind.",
    });
    return { skipped: false, violations };
  }

  if (algorithm.step2Tokens.size === 0 || algorithm.step4Tokens.size === 0) {
    violations.push({
      invariant: "PARSE",
      subject: ALGORITHM_MARKER,
      line: algorithm.line,
      message:
        `Found "${ALGORITHM_MARKER}" but parsed ${algorithm.step2Tokens.size} step-2 gate(s) and ` +
        `${algorithm.step4Tokens.size} step-4 branch(es). The algorithm block's shape changed; ` +
        "I1 and I2 cannot be evaluated. Fix parseVerdictAlgorithm() — do not treat this as a pass.",
    });
    return { skipped: false, violations };
  }

  // If §7 declares step-3a manual-test AC enforcement, BOTH halves of that
  // detection must be readable — `grep` finds the lines, `awk` says which AC
  // each belongs to. Deleting or malforming either leaves the declared
  // enforcement with nothing behind it, the same prose-only condition I1 exists
  // to catch, one level down. Checking only the grep half is how mutation
  // testing found the awk half could be stripped with a green suite.
  if (content.includes(STEP_3A_ANCHOR)) {
    const halves: Array<[string, RegExp | null, string]> = [
      ["detection", parseEvidenceAcPattern(content), MANUAL_TEST_ANCHOR],
      [
        "AC-ID attribution",
        parseEvidenceAcIdPattern(content),
        MANUAL_AC_ID_ANCHOR,
      ],
    ];
    for (const [half, pattern, anchor] of halves) {
      if (pattern !== null) continue;
      violations.push({
        invariant: "PARSE",
        subject: "Manual Test AC Enforcement",
        message:
          `§7 declares step-3a manual test AC enforcement, but its ${half} half ` +
          `has no compilable pattern in the \`${anchor}\` block. ` +
          "The declared enforcement has no detection behind it.",
      });
    }
  }

  const algorithmSection = sections.find((s) =>
    s.body.includes(ALGORITHM_MARKER),
  );

  const checklists = parseChecklists(content);
  const templates = parseTemplateSections(content);

  violations.push(
    ...checkI1(sections, algorithm, algorithmSection?.id ?? null),
  );
  violations.push(...checkI2(sections, algorithm));

  if (checklists.found && checklists.standard.length === 0) {
    violations.push({
      invariant: "PARSE",
      subject: "Output Verification",
      message:
        "Found `## Output Verification` but parsed zero Standard checklist entries. " +
        "I3 and I4 cannot be evaluated — fix parseChecklists() rather than reporting a pass.",
    });
  } else if (checklists.found) {
    violations.push(...checkI3(sections, checklists));
  }

  if (templates.found && templates.standard.length === 0) {
    violations.push({
      invariant: "PARSE",
      subject: "Output Template",
      message:
        "Found `## Output Template` but parsed zero Standard template sections. " +
        "I4 cannot be evaluated — fix parseTemplateSections() rather than reporting a pass.",
    });
  } else if (
    checklists.found &&
    templates.found &&
    checklists.standard.length > 0
  ) {
    violations.push(...checkI4(checklists, templates));
  }

  return { skipped: false, violations };
}

// ---------------------------------------------------------------------------
// Project scan
// ---------------------------------------------------------------------------

function findSkillFiles(baseDir: string): string[] {
  const files: string[] = [];
  if (!existsSync(baseDir)) return files;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "SKILL.md") files.push(full);
    }
  }

  walk(baseDir);
  return files.sort();
}

export interface LintResult {
  root: string | null;
  scanned: number;
  skipped: string[];
  violations: FileViolation[];
}

export function lintSkillGates(projectRoot: string): LintResult {
  const root = SCAN_ROOTS.find((r) => existsSync(join(projectRoot, r))) ?? null;
  const result: LintResult = { root, scanned: 0, skipped: [], violations: [] };
  if (!root) return result;

  for (const full of findSkillFiles(join(projectRoot, root))) {
    result.scanned++;
    const rel = relative(projectRoot, full);
    const fileResult = lintSkillContent(readFileSync(full, "utf-8"));
    if (fileResult.skipped) {
      result.skipped.push(rel);
      continue;
    }
    for (const v of fileResult.violations) {
      result.violations.push({ ...v, file: rel });
    }
  }

  return result;
}

function printReport(result: LintResult): void {
  if (!result.root) {
    console.log(
      `No skill directory found (looked for ${SCAN_ROOTS.join(", ")}).`,
    );
    return;
  }
  console.log(
    `Linting verdict-enforcement chains in ${result.root}/**/SKILL.md`,
  );
  console.log(
    `Files scanned: ${result.scanned} (${result.skipped.length} skipped — no verdict algorithm)`,
  );
  console.log("");

  if (result.violations.length === 0) {
    console.log(
      "No violations. Every declared verdict floor is reachable from §7.",
    );
    return;
  }

  for (const v of result.violations) {
    const at = v.line ? `${v.file}:${v.line}` : v.file;
    console.log(`${at}: [${v.invariant}] ${v.subject}`);
    console.log(`  ${v.message}`);
    console.log("");
  }
  console.log(
    `Found ${result.violations.length} violation(s). A gate that no §7 branch reads cannot fire. See #834.`,
  );
}

// CLI entry — only execute when run directly, not when imported by tests.
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const result = lintSkillGates(PROJECT_ROOT);
  printReport(result);
  process.exit(result.violations.length > 0 ? 1 : 0);
}
