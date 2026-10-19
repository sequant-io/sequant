/**
 * Run-log helpers shared by `sequant logs`, `sequant stats`, `merge --check`
 * and the sequant_logs / sequant_run MCP tools.
 */

import * as fs from "fs";
import * as os from "os";
import {
  RunLogSchema,
  type RunLog,
  LOG_PATHS,
} from "./workflow/run-log-schema.js";

/**
 * Resolve the log directory path
 */
export function resolveLogDir(customPath?: string): string {
  if (customPath) {
    return customPath.replace("~", os.homedir());
  }

  // Check project-level logs first
  const projectPath = LOG_PATHS.project;
  if (fs.existsSync(projectPath)) {
    return projectPath;
  }

  // Fall back to user-level logs
  const userPath = LOG_PATHS.user.replace("~", os.homedir());
  if (fs.existsSync(userPath)) {
    return userPath;
  }

  // Default to project path (even if it doesn't exist yet)
  return projectPath;
}

/**
 * List all log files in a directory
 */
export function listLogFiles(logDir: string): string[] {
  if (!fs.existsSync(logDir)) {
    return [];
  }

  return fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .sort()
    .reverse(); // Most recent first
}

/**
 * Parse a log file
 */
export function parseLogFile(filePath: string): RunLog | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    return RunLogSchema.parse(data);
  } catch {
    return null;
  }
}
