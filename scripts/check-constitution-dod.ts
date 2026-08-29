#!/usr/bin/env npx tsx
/**
 * Drift check: verify the DoD table in `templates/memory/constitution.md`
 * matches what `generate-constitution-dod.ts` produces from `qa/SKILL.md`.
 *
 * Fails CI when a §7 gate is added or removed without updating the constitution
 * template. Wired as `lint:constitution-dod` in package.json and as a CI step
 * alongside `lint:skill-gates`.
 *
 * Extraction is scoped to the <!-- BEGIN:DOD-GATES --> / <!-- END:DOD-GATES -->
 * delimited region — whole-file comparison would let unrelated constitution
 * prose satisfy the assertion (the #830 gate-test scoping trap).
 *
 * Usage:
 *   npx tsx scripts/check-constitution-dod.ts
 *
 * Exit codes:
 *   0 — Table is in sync
 *   1 — Drift detected (or file/section missing)
 *
 * Related: #943, generate-constitution-dod.ts, lint-skill-gates.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  PROJECT_ROOT,
  resolveQaSkillPath,
  generateDodTable,
} from "./generate-constitution-dod.js";

const CONSTITUTION_PATH = join(
  PROJECT_ROOT,
  "templates",
  "memory",
  "constitution.md",
);

export const BEGIN_MARKER = "<!-- BEGIN:DOD-GATES -->";
export const END_MARKER = "<!-- END:DOD-GATES -->";

/**
 * Extract the DoD section content from the constitution template.
 *
 * Scoped to the delimited region — returns null when the markers are absent
 * (treated as a drift: the template is missing its DoD section entirely).
 */
export function extractDodSection(content: string): string | null {
  const begin = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end <= begin) return null;
  return content.slice(begin + BEGIN_MARKER.length, end).trim();
}

// CLI entry — only when run directly.
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const qaPath = resolveQaSkillPath(PROJECT_ROOT);
  let qaContent: string;
  try {
    qaContent = readFileSync(qaPath, "utf-8");
  } catch {
    console.error(`❌ qa skill not found: ${qaPath}`);
    process.exit(1);
  }

  let constitutionContent: string;
  try {
    constitutionContent = readFileSync(CONSTITUTION_PATH, "utf-8");
  } catch {
    console.error(`❌ Constitution template not found: ${CONSTITUTION_PATH}`);
    process.exit(1);
  }

  const existing = extractDodSection(constitutionContent);
  if (existing === null) {
    console.error(
      `❌ DoD section markers not found in ${CONSTITUTION_PATH}.\n` +
        `Add <!-- BEGIN:DOD-GATES --> ... <!-- END:DOD-GATES --> to the template.`,
    );
    process.exit(1);
  }

  let generated: string;
  try {
    generated = generateDodTable(qaContent);
  } catch (err) {
    console.error(`❌ Failed to generate DoD table: ${(err as Error).message}`);
    process.exit(1);
  }

  if (existing.trim() === generated.trim()) {
    console.log("✅ Constitution DoD table is in sync with §7 gates.");
    process.exit(0);
  }

  console.error("❌ Constitution DoD table has drifted from §7 gates.");
  console.error("");
  console.error("Expected (from qa/SKILL.md §7 step-4):");
  console.error(generated);
  console.error("");
  console.error(`Found (in ${CONSTITUTION_PATH}):`);
  console.error(existing);
  console.error("");
  console.error(
    "Fix: run `npx tsx scripts/generate-constitution-dod.ts` and update\n" +
      "the <!-- BEGIN:DOD-GATES --> ... <!-- END:DOD-GATES --> region.",
  );
  process.exit(1);
}
