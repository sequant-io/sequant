/**
 * AGENTS.md generation and management
 *
 * Generates a universal AGENTS.md file that any AI coding agent can consume.
 * AGENTS.md contains the portable subset of CLAUDE.md instructions.
 */

import { readFile, writeFile, fileExists } from "./fs.js";
import { processTemplate } from "./templates.js";
import { getStackConfig } from "./stacks.js";
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
  return content.trimEnd() + "\n";
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
