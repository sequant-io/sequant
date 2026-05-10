/**
 * Gap-check signal-to-noise miner
 *
 * Mines QA / spec verdict comments on merged-PR issues, attributes each
 * "gap flag" to the SKILL.md section that produced it, and classifies
 * the fate of each flag (actioned / filed_followup / dismissed / silent).
 *
 * Output:
 *   - .sequant/gap-signal.jsonl  (one line per gap flag — raw mining output)
 *   - stdout summary table       (per-section action rate + token-cost proxy)
 *
 * Source of truth for the QA comment shape: `project_qa_comment_location.md`
 * (issue comments, not PR comments). Phase boundary marker:
 *   <!-- SEQUANT_PHASE: {"phase":"qa", ...} -->
 *
 * Heuristic-only: natural-language extraction is approximate.
 * The report (`docs/investigations/qa-gap-signal-to-noise.md`)
 * documents the noise floor and validation methodology.
 *
 * Usage:
 *   npx tsx scripts/analytics/gap-signal.ts --since 2026-04-01 [--limit 50] [--out path]
 *
 * @see https://github.com/sequant-io/sequant/issues/608
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Section catalog — drives section-attribution and token-cost proxy
// ---------------------------------------------------------------------------

export interface SectionDef {
  id: string;
  label: string;
  source: "qa" | "spec";
  // Header anchor inside the comment (case-insensitive substring match).
  header: RegExp;
  // Per-flag bullet anchor used to locate the in-comment finding (optional).
  flagAnchor?: RegExp;
  // Lines in the SKILL.md (computed at runtime by countSkillLines).
  skillFile: string;
  skillSectionAnchor: RegExp;
  introducingPr: number;
}

export const SECTIONS: SectionDef[] = [
  {
    id: "qa.s4q5",
    label: "§4 Q5 — intra-file sibling-line audit",
    source: "qa",
    header: /Risk Assessment/i,
    flagAnchor: /\*\*Sibling-line audit:\*\*/i,
    skillFile: ".claude/skills/qa/SKILL.md",
    skillSectionAnchor: /^### 4\. Failure Path & Edge Case Testing/m,
    introducingPr: 589,
  },
  {
    id: "qa.s5",
    label: "§5 — cross-file sibling-site scan",
    source: "qa",
    header: /Risk Assessment/i,
    flagAnchor: /\*\*Sibling sites considered:\*\*/i,
    skillFile: ".claude/skills/qa/SKILL.md",
    skillSectionAnchor: /^### 5\. Risk Assessment/m,
    introducingPr: 576,
  },
  {
    id: "qa.s6c",
    label: "§6c — detection-pattern verification",
    source: "qa",
    // §6c has its own canonical phrasing; do NOT match the generic §2e
    // "Anti-Pattern Detection" header — that's a separate (older) section
    // and conflating the two inflates §6c's "silent" bucket.
    header:
      /(Detection Pattern Verification|Section 6c|§6c|skill regex\/grep|skill regex changes)/i,
    skillFile: ".claude/skills/qa/SKILL.md",
    skillSectionAnchor: /^### 6c\./m,
    introducingPr: 572,
  },
  {
    id: "qa.s6d",
    label: "§6d — Adversarial Re-Read",
    source: "qa",
    header: /Adversarial Re-?Read/i,
    skillFile: ".claude/skills/qa/SKILL.md",
    skillSectionAnchor: /^### 6d\./m,
    introducingPr: 584,
  },
  {
    id: "spec.sibling",
    label: "Spec — sibling-site scan",
    source: "spec",
    header: /Sibling-?site Scan/i,
    skillFile: ".claude/skills/spec/SKILL.md",
    skillSectionAnchor: /Sibling-?site Scan/i,
    introducingPr: 594,
  },
  {
    id: "spec.aclinter",
    label: "Spec — AC linter (title/body tension)",
    source: "spec",
    header: /(AC Quality Check|AC Linter|title.body.tension)/i,
    skillFile: ".claude/skills/spec/SKILL.md",
    skillSectionAnchor: /AC Linter|title.body.tension/i,
    introducingPr: 586,
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Fate =
  | "actioned_in_pr"
  | "filed_followup"
  | "dismissed"
  | "silent"
  | "not_triggered";

export interface GapFlag {
  issueNumber: number;
  prNumber: number | null;
  sectionId: string;
  sectionLabel: string;
  source: "qa" | "spec";
  // Did the section produce a substantive finding? false = N/A / Not Required / clean
  triggered: boolean;
  // Short excerpt of the flag text for human review
  excerpt: string;
  fate: Fate;
  fateEvidence: string;
  commentTimestamp: string;
}

export interface SectionRollup {
  sectionId: string;
  label: string;
  totalRuns: number; // total comments where the section was emitted
  triggered: number; // section produced a flag
  byFate: Record<Fate, number>;
  actionRate: number; // (actioned + filed) / triggered
  skillLines: number;
  skillWords: number;
}

export interface MiningReport {
  generatedAt: string;
  window: { since: string; until: string };
  totals: {
    issuesScanned: number;
    qaCommentsParsed: number;
    specCommentsParsed: number;
    flagsTotal: number;
  };
  sections: SectionRollup[];
  rawFlagsPath: string;
}

interface IssueComment {
  body: string;
  createdAt: string;
}

interface IssueRecord {
  number: number;
  prNumber: number | null;
  comments: IssueComment[];
  bodyText: string;
}

// ---------------------------------------------------------------------------
// gh data fetchers
// ---------------------------------------------------------------------------

function listMergedPrIssues(since: string, limit: number): number[] {
  const raw = execSync(
    `gh pr list --state merged --limit ${limit} --search "merged:>=${since}" --json number,title`,
    { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
  );
  const prs = JSON.parse(raw) as Array<{
    number: number;
    title: string;
  }>;
  // Project convention: PR titles encode the closing issue as `feat(#NNN):`,
  // `fix(#NNN):`, etc. Parse the issue number out of the title; fall back to
  // the PR number when no marker is present.
  const issues = new Set<number>();
  for (const pr of prs) {
    const m = pr.title.match(/\(#(\d+)\)/);
    issues.add(m ? parseInt(m[1], 10) : pr.number);
  }
  return [...issues].sort((a, b) => a - b);
}

function fetchIssue(num: number): IssueRecord | null {
  try {
    const raw = execSync(`gh issue view ${num} --json number,body,comments`, {
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const data = JSON.parse(raw) as {
      number: number;
      body: string;
      comments: Array<{ body: string; createdAt: string }>;
    };
    return {
      number: data.number,
      prNumber: null,
      bodyText: data.body ?? "",
      comments: data.comments ?? [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Comment classification — qa vs spec via SEQUANT_PHASE marker
// ---------------------------------------------------------------------------

function commentPhase(body: string): "qa" | "spec" | "exec" | null {
  const m = body.match(/SEQUANT_PHASE:\s*\{[^}]*"phase":"(qa|spec|exec)"/);
  return (m?.[1] as "qa" | "spec" | "exec" | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Gap-flag extraction per section
// ---------------------------------------------------------------------------

const NA_RE =
  /\b(N\/A|Not Required|none(?: --? | — | - )|single-call-site|no cross-file siblings|no findings|all clean|nothing material|All \d+ ACs? pass(?:ed)?\s+lint|No (?:issues|anti-patterns|code patterns?) (?:detected|to flag|flagged|applicable)|no vague|all \d+ ACs are specific)/i;

function extractFlag(
  comment: IssueComment,
  section: SectionDef,
): { triggered: boolean; excerpt: string } | null {
  const body = comment.body;

  // Section must appear in the comment for it to count as "emitted"
  if (!section.header.test(body)) return null;

  // For sections with a per-flag bullet anchor, extract the bullet text;
  // otherwise extract a window after the header.
  let excerpt: string;
  if (section.flagAnchor) {
    const idx = body.search(section.flagAnchor);
    if (idx < 0) {
      // Header present but the bullet is missing — section emitted but no answer
      // (treat as not-triggered for action-rate purposes, but still count as a run).
      return { triggered: false, excerpt: "" };
    }
    const slice = body.slice(idx, idx + 600);
    // Trim to next bullet or paragraph
    const stop = slice.search(/\n\s*\n|\n-\s|\n\*\*/);
    excerpt = (stop > 0 ? slice.slice(0, stop) : slice).trim();
  } else {
    const idx = body.search(section.header);
    const slice = body.slice(idx, idx + 1500);
    const stop = slice.search(/\n###\s|\n---\n/);
    excerpt = (stop > 0 ? slice.slice(0, stop) : slice).trim();
  }

  const triggered = !NA_RE.test(excerpt) && excerpt.length > 60;
  return { triggered, excerpt: excerpt.slice(0, 400) };
}

// ---------------------------------------------------------------------------
// Fate classification (heuristic)
// ---------------------------------------------------------------------------

const FOLLOWUP_RE =
  /(filed?\s+(?:as\s+)?#?\d+|follow-?up issue|file a follow-?up|filed follow-?up|opened #?\d+|tracked in #?\d+)/i;
const DISMISS_RE =
  /(non-blocking|out of scope|Non-Goals|deferred|not (?:in|within) scope|won't fix|acceptable as-?is)/i;
const ACTIONED_RE =
  /(fixed in|addressed|applied fix|patched in this PR|resolved before merge|round-?2 fix)/i;

function classifyFate(
  excerpt: string,
  fullBody: string,
  triggered: boolean,
): { fate: Fate; evidence: string } {
  if (!triggered) return { fate: "not_triggered", evidence: "" };

  // Search a 1.5KB neighbourhood around the excerpt within the full body
  // to catch fate signals that follow the flag (e.g., the next "Suggestions"
  // / "Next Steps" block).
  const idx = fullBody.indexOf(excerpt.slice(0, 80));
  const win = fullBody.slice(Math.max(0, idx - 200), idx + 1800);

  if (FOLLOWUP_RE.test(win)) {
    const m = win.match(FOLLOWUP_RE);
    return { fate: "filed_followup", evidence: m?.[0] ?? "" };
  }
  if (ACTIONED_RE.test(win)) {
    const m = win.match(ACTIONED_RE);
    return { fate: "actioned_in_pr", evidence: m?.[0] ?? "" };
  }
  if (DISMISS_RE.test(win)) {
    const m = win.match(DISMISS_RE);
    return { fate: "dismissed", evidence: m?.[0] ?? "" };
  }
  return { fate: "silent", evidence: "" };
}

// ---------------------------------------------------------------------------
// Per-section token-cost proxy (line + word count of the SKILL.md section)
// ---------------------------------------------------------------------------

interface SkillCost {
  lines: number;
  words: number;
}

export function measureSkillCost(section: SectionDef): SkillCost {
  if (!fs.existsSync(section.skillFile)) {
    return { lines: 0, words: 0 };
  }
  const content = fs.readFileSync(section.skillFile, "utf-8");
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => section.skillSectionAnchor.test(l));
  if (startIdx < 0) return { lines: 0, words: 0 };

  // End at the next sibling-level header (### or ##)
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^###?\s/.test(lines[i]) && !/^####/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const sectionLines = lines.slice(startIdx, endIdx);
  const words = sectionLines.join(" ").split(/\s+/).filter(Boolean).length;
  return { lines: sectionLines.length, words };
}

// ---------------------------------------------------------------------------
// Main mining loop
// ---------------------------------------------------------------------------

export interface MineOptions {
  since: string;
  limit: number;
  out: string;
  // Optional injected fetchers for testing
  fetchers?: {
    listIssues?: typeof listMergedPrIssues;
    fetchIssue?: typeof fetchIssue;
  };
}

export function mine(options: MineOptions): MiningReport {
  const listFn = options.fetchers?.listIssues ?? listMergedPrIssues;
  const fetchFn = options.fetchers?.fetchIssue ?? fetchIssue;

  const issueNums = listFn(options.since, options.limit);
  const flags: GapFlag[] = [];
  let qaParsed = 0;
  let specParsed = 0;

  for (const num of issueNums) {
    const issue = fetchFn(num);
    if (!issue) continue;

    for (const comment of issue.comments) {
      const phase = commentPhase(comment.body);
      if (phase !== "qa" && phase !== "spec") continue;
      if (phase === "qa") qaParsed++;
      if (phase === "spec") specParsed++;

      for (const section of SECTIONS) {
        if (section.source !== phase) continue;
        const found = extractFlag(comment, section);
        if (!found) continue;
        const { fate, evidence } = classifyFate(
          found.excerpt,
          comment.body,
          found.triggered,
        );
        flags.push({
          issueNumber: issue.number,
          prNumber: issue.prNumber,
          sectionId: section.id,
          sectionLabel: section.label,
          source: section.source,
          triggered: found.triggered,
          excerpt: found.excerpt,
          fate,
          fateEvidence: evidence,
          commentTimestamp: comment.createdAt,
        });
      }
    }
  }

  // Persist raw flags
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(
    options.out,
    flags.map((f) => JSON.stringify(f)).join("\n") + "\n",
  );

  // Roll up per section
  const sectionRollups: SectionRollup[] = SECTIONS.map((section) => {
    const sectionFlags = flags.filter((f) => f.sectionId === section.id);
    const triggered = sectionFlags.filter((f) => f.triggered);
    const byFate: Record<Fate, number> = {
      actioned_in_pr: 0,
      filed_followup: 0,
      dismissed: 0,
      silent: 0,
      not_triggered: 0,
    };
    for (const f of sectionFlags) byFate[f.fate]++;
    const actioned = byFate.actioned_in_pr + byFate.filed_followup;
    const cost = measureSkillCost(section);
    return {
      sectionId: section.id,
      label: section.label,
      totalRuns: sectionFlags.length,
      triggered: triggered.length,
      byFate,
      actionRate: triggered.length > 0 ? actioned / triggered.length : 0,
      skillLines: cost.lines,
      skillWords: cost.words,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    window: {
      since: options.since,
      until: new Date().toISOString().slice(0, 10),
    },
    totals: {
      issuesScanned: issueNums.length,
      qaCommentsParsed: qaParsed,
      specCommentsParsed: specParsed,
      flagsTotal: flags.length,
    },
    sections: sectionRollups,
    rawFlagsPath: options.out,
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function formatPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function displayReport(report: MiningReport): void {
  console.log("=".repeat(78));
  console.log("  GAP-CHECK SIGNAL-TO-NOISE  —  Issue #608");
  console.log(
    `  ${report.window.since} → ${report.window.until}  |  ${report.totals.issuesScanned} issues  |  ${report.totals.flagsTotal} flag rows`,
  );
  console.log("=".repeat(78));
  console.log();
  console.log(`  QA comments parsed:   ${report.totals.qaCommentsParsed}`);
  console.log(`  Spec comments parsed: ${report.totals.specCommentsParsed}`);
  console.log();
  console.log("## Per-section action rate (triggered → actioned/filed)");
  console.log();
  console.log(
    "  Section                                     Runs  Trig  Act+File  Dism  Silent  Action%  Lines",
  );
  console.log("  " + "-".repeat(98));
  const sortedSections = [...report.sections].sort(
    (a, b) => b.actionRate - a.actionRate,
  );
  for (const s of sortedSections) {
    const acted = s.byFate.actioned_in_pr + s.byFate.filed_followup;
    console.log(
      `  ${s.label.padEnd(43)}  ${String(s.totalRuns).padStart(4)}  ${String(s.triggered).padStart(4)}  ${String(acted).padStart(8)}  ${String(s.byFate.dismissed).padStart(4)}  ${String(s.byFate.silent).padStart(6)}  ${formatPct(s.actionRate).padStart(7)}  ${String(s.skillLines).padStart(5)}`,
    );
  }
  console.log();
  console.log(`  Raw flags: ${report.rawFlagsPath}`);
  console.log();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function main() {
  const since = parseArg("--since", "2026-04-01");
  const limit = parseInt(parseArg("--limit", "50"), 10);
  const out = parseArg("--out", ".sequant/gap-signal.jsonl");
  const jsonFlag = process.argv.includes("--json");

  const report = mine({ since, limit, out });

  if (jsonFlag) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    displayReport(report);
  }
}

// ESM entry-point check (this file is treated as ESM by the project tsconfig).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
