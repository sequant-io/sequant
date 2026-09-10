/**
 * AGENTS.md generation and management
 *
 * Generates a universal AGENTS.md file that any AI coding agent can consume.
 * AGENTS.md contains the portable subset of CLAUDE.md instructions.
 */

import { createHash } from "crypto";
import { readFile, writeFile, fileExists } from "./fs.js";
import { processTemplate } from "./templates.js";
import { getStackConfig } from "./stacks.js";
import { getPackageVersion } from "./manifest.js";
import {
  loadConventions,
  type ConventionsFile,
} from "./conventions-detector.js";

/** Sections in CLAUDE.md that are Claude Code-specific and should NOT be ported */
const CLAUDE_SPECIFIC_PATTERNS = [
  /^##\s*Slash Commands/i,
  /^##\s*Hook Configuration/i,
  /^##\s*Hooks?$/i,
  /^##\s*Claude Code/i,
  /^##\s*MCP\b/i,
  /^##\s*Skills?$/i,
];

/** Path to AGENTS.md in project root */
export const AGENTS_MD_PATH = "AGENTS.md";

/**
 * Marker line prepended to every sequant-generated AGENTS.md (#990). `h` is
 * the sha1 of everything after the marker line's own newline — recomputing it
 * from the current body and comparing to the recorded hash tells sync whether
 * the file is still exactly what sequant generated (safe to regenerate) or was
 * hand-edited / pre-existing (must be preserved, like `CUSTOMIZABLE_FILES`).
 */
const AGENTS_MD_MARKER_PATTERN =
  /^<!-- sequant:agents-md v=(\S+) h=([0-9a-f]{40}) -->$/;

export interface AgentsMdMarker {
  version: string;
  hash: string;
}

/** sha1 of the AGENTS.md body (everything after the marker line). */
export function hashAgentsMdBody(body: string): string {
  return createHash("sha1").update(body).digest("hex");
}

/** Build the marker line for a given body, defaulting to the installed package version. */
export function buildAgentsMdMarker(
  body: string,
  version: string = getPackageVersion(),
): string {
  return `<!-- sequant:agents-md v=${version} h=${hashAgentsMdBody(body)} -->`;
}

/** Parse the marker from an AGENTS.md file's first line, or `null` if absent/malformed. */
export function parseAgentsMdMarker(content: string): AgentsMdMarker | null {
  const firstLineEnd = content.indexOf("\n");
  const firstLine =
    firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
  const match = firstLine.match(AGENTS_MD_MARKER_PATTERN);
  if (!match) return null;
  return { version: match[1], hash: match[2] };
}

/** Everything after the marker line, or the whole content if there is no marker. */
export function stripAgentsMdMarker(content: string): string {
  const firstLineEnd = content.indexOf("\n");
  if (firstLineEnd === -1) return content;
  const firstLine = content.slice(0, firstLineEnd);
  if (!AGENTS_MD_MARKER_PATTERN.test(firstLine)) return content;
  return content.slice(firstLineEnd + 1);
}

/**
 * Whether an on-disk AGENTS.md is unmodified sequant output: it carries a
 * marker whose recorded hash matches the current body. A missing marker or a
 * hash mismatch means the file was hand-edited or predates the marker, so it
 * is user-owned and must not be silently regenerated (#990).
 */
export function isAgentsMdSequantOwned(content: string): boolean {
  const marker = parseAgentsMdMarker(content);
  if (!marker) return false;
  return hashAgentsMdBody(stripAgentsMdMarker(content)) === marker.hash;
}

/**
 * Decide what `sync`/`doctor` should do with an existing (or absent) AGENTS.md.
 *
 * - `"skipped (--no-agents-md)"`: the caller opted out of AGENTS.md entirely.
 * - `"none"`: no file exists — sync never creates one from scratch.
 * - `"regenerate"`: `--force`, or the file is unmodified sequant output.
 * - `"preserved"`: the file is user-owned (unmarked or hash-mismatched).
 */
export function decideAgentsMdSync(params: {
  enabled: boolean;
  existingContent: string | null;
  force: boolean;
}): "skipped (--no-agents-md)" | "none" | "regenerate" | "preserved" {
  if (!params.enabled) return "skipped (--no-agents-md)";
  if (params.existingContent === null) return "none";
  if (params.force) return "regenerate";
  return isAgentsMdSequantOwned(params.existingContent)
    ? "regenerate"
    : "preserved";
}

/** Configuration for generating AGENTS.md */
export interface AgentsMdConfig {
  projectName: string;
  stack: string;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
}

/**
 * The AGENTS.md template with {{TOKEN}} placeholders.
 * Follows the standard format from https://github.com/agentsmd/agents.md
 */
const AGENTS_MD_TEMPLATE = `# AGENTS.md

## Project Overview

**{{PROJECT_NAME}}** is built with **{{STACK}}**.

## Development Commands

| Command | Purpose |
|---------|---------|
| \`{{BUILD_COMMAND}}\` | Build the project |
| \`{{TEST_COMMAND}}\` | Run tests |
| \`{{LINT_COMMAND}}\` | Lint the codebase |

## Code Conventions

{{CONVENTIONS_SECTION}}

## Directory Structure

Follow existing project conventions for file placement and naming.

## Workflow

This project uses [Sequant](https://github.com/sequant-io/sequant) for structured AI-assisted development.

To work on a GitHub issue:

\`\`\`bash
npx sequant run <issue-number>
\`\`\`

This runs a structured workflow: spec → exec → qa.

{{PORTABLE_INSTRUCTIONS}}
`;

/**
 * Generate AGENTS.md content from project configuration
 */
export async function generateAgentsMd(
  config: AgentsMdConfig,
): Promise<string> {
  const stackConfig = getStackConfig(config.stack);

  const buildCmd =
    config.buildCommand ||
    stackConfig.variables.BUILD_COMMAND ||
    "npm run build";
  const testCmd =
    config.testCommand || stackConfig.variables.TEST_COMMAND || "npm test";
  const lintCmd =
    config.lintCommand || stackConfig.variables.LINT_COMMAND || "npm run lint";

  // Load conventions if available
  const conventionsSection = await getConventionsSection();

  // Check for CLAUDE.md and extract portable instructions
  const portableInstructions = await getPortableInstructions();

  const variables: Record<string, string> = {
    PROJECT_NAME: config.projectName,
    STACK: stackConfig.displayName || config.stack,
    BUILD_COMMAND: buildCmd,
    TEST_COMMAND: testCmd,
    LINT_COMMAND: lintCmd,
    CONVENTIONS_SECTION: conventionsSection,
    PORTABLE_INSTRUCTIONS: portableInstructions,
  };

  let content = processTemplate(AGENTS_MD_TEMPLATE, variables);

  // Clean up empty sections
  content = content.replace(/\n{3,}/g, "\n\n");
  const body = content.trimEnd() + "\n";

  // Prepend the ownership marker (#990) so a future sync can tell this exact
  // output apart from a user-edited or pre-existing AGENTS.md.
  return `${buildAgentsMdMarker(body)}\n${body}`;
}

/**
 * Extract portable (non-Claude-specific) instructions from CLAUDE.md
 */
export function extractPortableInstructions(claudeMdContent: string): string {
  const lines = claudeMdContent.split("\n");
  const portableLines: string[] = [];
  let skipSection = false;

  for (const line of lines) {
    // Check if this line starts a Claude-specific section
    if (line.startsWith("## ")) {
      skipSection = CLAUDE_SPECIFIC_PATTERNS.some((pattern) =>
        pattern.test(line),
      );
    }

    if (!skipSection) {
      portableLines.push(line);
    }
  }

  const result = portableLines.join("\n").trim();

  // Remove the top-level heading (e.g. "# Sequant") since AGENTS.md has its own
  const withoutTopHeading = result.replace(/^#\s+.*\n*/, "").trim();

  return withoutTopHeading;
}

/**
 * Check if AGENTS.md is consistent with CLAUDE.md content.
 * Returns a description of inconsistencies, or null if consistent.
 */
export function checkAgentsMdConsistency(
  agentsMdContent: string,
  claudeMdContent: string,
): string | null {
  const issues: string[] = [];

  // Extract portable instructions from current CLAUDE.md
  const portable = extractPortableInstructions(claudeMdContent);

  // Check if key sections from CLAUDE.md portable content appear in AGENTS.md
  // We check for commit rules and other conventions that should be shared
  const commitRulePatterns = [/Co-Authored-By/i, /commit rules?/i];

  for (const pattern of commitRulePatterns) {
    const inClaude = pattern.test(portable);
    const inAgents = pattern.test(agentsMdContent);
    if (inClaude && !inAgents) {
      issues.push(
        `CLAUDE.md contains "${pattern.source}" but AGENTS.md does not`,
      );
    }
  }

  return issues.length > 0 ? issues.join("; ") : null;
}

/**
 * Format conventions for AGENTS.md output
 */
export function formatConventionsAsAgentsMd(
  conventions: ConventionsFile,
): string {
  const lines: string[] = ["# AGENTS.md", "", "## Code Conventions", ""];

  const detected = Object.entries(conventions.detected);
  const manual = Object.entries(conventions.manual);
  const all = [...detected, ...manual];

  if (all.length === 0) {
    lines.push("No conventions detected.");
  } else {
    for (const [key, value] of all) {
      lines.push(`- **${key}**: ${value}`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Write AGENTS.md to the project root
 */
export async function writeAgentsMd(content: string): Promise<void> {
  await writeFile(AGENTS_MD_PATH, content);
}

/**
 * Read existing AGENTS.md if present
 */
export async function readAgentsMd(): Promise<string | null> {
  if (!(await fileExists(AGENTS_MD_PATH))) {
    return null;
  }
  try {
    return await readFile(AGENTS_MD_PATH);
  } catch {
    // File read failed — treat as missing (non-blocking)
    return null;
  }
}

// -- Internal helpers --

async function getConventionsSection(): Promise<string> {
  try {
    const conventions = await loadConventions();
    if (!conventions)
      return "Follow existing project patterns and naming conventions.";

    const detected = Object.entries(conventions.detected);
    const manual = Object.entries(conventions.manual);
    const all = [...manual, ...detected]; // manual overrides first

    if (all.length === 0)
      return "Follow existing project patterns and naming conventions.";

    const lines: string[] = [];
    for (const [key, value] of all) {
      lines.push(`- **${key}**: ${value}`);
    }
    return lines.join("\n");
  } catch {
    // Convention loading failed — fall back to generic guidance (non-blocking)
    return "Follow existing project patterns and naming conventions.";
  }
}

async function getPortableInstructions(): Promise<string> {
  try {
    if (!(await fileExists("CLAUDE.md"))) return "";
    const claudeMd = await readFile("CLAUDE.md");
    const portable = extractPortableInstructions(claudeMd);
    if (!portable) return "";

    return `## Project-Specific Instructions\n\n${portable}`;
  } catch {
    // CLAUDE.md read/parse failed — skip portable instructions (non-blocking)
    return "";
  }
}
