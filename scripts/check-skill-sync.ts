#!/usr/bin/env npx tsx
/**
 * Check three-directory skill sync
 *
 * Compares files across .claude/skills/, templates/skills/, and skills/
 * to detect divergence. Source of truth: .claude/skills/
 *
 * Usage:
 *   npx tsx scripts/check-skill-sync.ts          # Check and report
 *   npx tsx scripts/check-skill-sync.ts --fix     # Copy from .claude/skills/ to other dirs
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  copyFileSync,
  mkdirSync,
} from "fs";
import { join, dirname, relative } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const SOURCE_DIR = join(PROJECT_ROOT, ".claude/skills");
const MIRROR_DIRS = [
  join(PROJECT_ROOT, "templates/skills"),
  join(PROJECT_ROOT, "skills"),
];
const DIR_LABELS = [".claude/skills", "templates/skills", "skills"];

const fixMode = process.argv.includes("--fix");

interface FileResult {
  relativePath: string;
  status: "synced" | "diverged" | "missing";
  details: string;
  lineCountSource?: number;
  lineCounts?: (number | null)[];
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function countLines(content: string): number {
  return content.split("\n").length;
}

function collectFiles(baseDir: string): string[] {
  const files: string[] = [];
  if (!existsSync(baseDir)) return files;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        files.push(relative(baseDir, full));
      }
    }
  }

  walk(baseDir);
  return files.sort();
}

function checkSync(): FileResult[] {
  const results: FileResult[] = [];
  const sourceFiles = collectFiles(SOURCE_DIR);

  for (const relPath of sourceFiles) {
    const sourceFull = join(SOURCE_DIR, relPath);
    const sourceContent = readFileSync(sourceFull, "utf-8");
    const sourceHash = hash(sourceContent);
    const sourceLines = countLines(sourceContent);

    const lineCounts: (number | null)[] = [sourceLines];
    let allMatch = true;
    let anyMissing = false;
    const missingIn: string[] = [];
    const divergedIn: string[] = [];

    for (let i = 0; i < MIRROR_DIRS.length; i++) {
      const mirrorFull = join(MIRROR_DIRS[i], relPath);

      if (!existsSync(mirrorFull)) {
        lineCounts.push(null);
        allMatch = false;
        anyMissing = true;
        missingIn.push(DIR_LABELS[i + 1]);
        continue;
      }

      const mirrorContent = readFileSync(mirrorFull, "utf-8");
      const mirrorHash = hash(mirrorContent);
      const mirrorLines = countLines(mirrorContent);
      lineCounts.push(mirrorLines);

      if (sourceHash !== mirrorHash) {
        allMatch = false;
        divergedIn.push(`${DIR_LABELS[i + 1]}: ${mirrorLines} lines`);
      }
    }

    if (allMatch) {
      results.push({
        relativePath: relPath,
        status: "synced",
        details: `${lineCounts.filter((c) => c !== null).length}/3 match`,
        lineCountSource: sourceLines,
        lineCounts,
      });
    } else if (anyMissing && divergedIn.length === 0) {
      results.push({
        relativePath: relPath,
        status: "missing",
        details: `missing in: ${missingIn.join(", ")}`,
        lineCountSource: sourceLines,
        lineCounts,
      });
    } else {
      const parts: string[] = [];
      if (divergedIn.length > 0) parts.push(divergedIn.join("; "));
      if (missingIn.length > 0) parts.push(`missing: ${missingIn.join(", ")}`);
      results.push({
        relativePath: relPath,
        status: "diverged",
        details: `.claude/skills: ${sourceLines} lines | ${parts.join(" | ")}`,
        lineCountSource: sourceLines,
        lineCounts,
      });
    }
  }

  // Check for files that exist in mirror dirs but NOT in source
  for (let i = 0; i < MIRROR_DIRS.length; i++) {
    const mirrorFiles = collectFiles(MIRROR_DIRS[i]);
    for (const relPath of mirrorFiles) {
      if (!sourceFiles.includes(relPath)) {
        if (!results.find((r) => r.relativePath === relPath)) {
          results.push({
            relativePath: relPath,
            status: "missing",
            details: `exists in ${DIR_LABELS[i + 1]} but not in .claude/skills (orphan)`,
            lineCounts: [null],
          });
        }
      }
    }
  }

  return results;
}

function fixDivergence(results: FileResult[]): number {
  let fixed = 0;

  for (const result of results) {
    if (result.status === "synced") continue;

    const sourceFull = join(SOURCE_DIR, result.relativePath);

    if (!existsSync(sourceFull)) {
      console.log(`  Skipping orphan: ${result.relativePath}`);
      continue;
    }

    for (const mirrorDir of MIRROR_DIRS) {
      const mirrorFull = join(mirrorDir, result.relativePath);
      const mirrorLabel = relative(PROJECT_ROOT, mirrorDir);

      if (existsSync(mirrorFull)) {
        const sourceHash = hash(readFileSync(sourceFull, "utf-8"));
        const mirrorHash = hash(readFileSync(mirrorFull, "utf-8"));
        if (sourceHash === mirrorHash) continue;
      }

      const parentDir = dirname(mirrorFull);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      copyFileSync(sourceFull, mirrorFull);
      console.log(`  Fixed: ${result.relativePath} → ${mirrorLabel}`);
      fixed++;
    }
  }

  return fixed;
}

function printReport(results: FileResult[]): void {
  const synced = results.filter((r) => r.status === "synced");
  const diverged = results.filter((r) => r.status === "diverged");
  const missing = results.filter((r) => r.status === "missing");

  for (const r of synced) {
    console.log(`  synced  ${r.relativePath} — ${r.details}`);
  }
  for (const r of missing) {
    console.log(`  missing ${r.relativePath} — ${r.details}`);
  }
  for (const r of diverged) {
    console.log(`  DIVERGED ${r.relativePath} — ${r.details}`);
  }

  console.log("");
  console.log(
    `Summary: ${synced.length} synced, ${diverged.length} diverged, ${missing.length} missing (${results.length} total)`,
  );
}

// Main
const results = checkSync();

console.log(
  "Skill sync check (.claude/skills/ → templates/skills/, skills/):\n",
);
printReport(results);

if (fixMode) {
  const divergedOrMissing = results.filter((r) => r.status !== "synced");
  if (divergedOrMissing.length === 0) {
    console.log("\nNothing to fix — all files synced.");
  } else {
    console.log("\nFixing divergence...");
    const fixed = fixDivergence(results);
    console.log(`\nFixed ${fixed} file(s).`);

    const postFixResults = checkSync();
    const postDiverged = postFixResults.filter((r) => r.status !== "synced");
    if (postDiverged.length === 0) {
      console.log("All files now synced.");
    } else {
      console.log(
        `${postDiverged.length} file(s) still not synced (orphans or source-missing).`,
      );
    }
  }
}

const hasDivergence = results.some(
  (r) => r.status === "diverged" || r.status === "missing",
);
process.exit(hasDivergence ? 1 : 0);
