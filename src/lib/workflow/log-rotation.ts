/**
 * Log rotation management for workflow run logs
 *
 * Implements automatic log rotation based on size and file count thresholds.
 * Deletes oldest logs first until within limits.
 *
 * @example
 * ```typescript
 * import { rotateIfNeeded, getLogStats, manualRotate } from './log-rotation';
 *
 * // Auto-rotate after a run
 * await rotateIfNeeded('.sequant/logs');
 *
 * // Get statistics
 * const stats = await getLogStats('.sequant/logs');
 * console.log(`${stats.fileCount} files, ${stats.totalSizeMB.toFixed(2)}MB`);
 *
 * // Manual rotation with dry-run
 * const result = await manualRotate('.sequant/logs', { dryRun: true });
 * console.log(`Would delete ${result.deletedCount} files`);
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Rotation settings
 */
export interface RotationSettings {
  /** Enable automatic rotation (default: true) */
  enabled: boolean;
  /** Maximum total size in MB before rotation (default: 10) */
  maxSizeMB: number;
  /** Maximum file count before rotation (default: 100) */
  maxFiles: number;
}

/**
 * Default rotation settings
 */
export const DEFAULT_ROTATION_SETTINGS: RotationSettings = {
  enabled: true,
  maxSizeMB: 10,
  maxFiles: 100,
};

/**
 * Log directory statistics
 */
export interface LogStats {
  /** Total size in bytes */
  totalSizeBytes: number;
  /** Total size in megabytes */
  totalSizeMB: number;
  /** Number of log files */
  fileCount: number;
  /** Oldest log file */
  oldestFile: string | null;
  /** Newest log file */
  newestFile: string | null;
  /** Whether size threshold is exceeded */
  exceedsSizeThreshold: boolean;
  /** Whether file count threshold is exceeded */
  exceedsCountThreshold: boolean;
}

/**
 * Result of a rotation operation
 */
export interface RotationResult {
  /** Files that were deleted (or would be in dry-run) */
  deletedFiles: string[];
  /** Number of files deleted */
  deletedCount: number;
  /** Bytes reclaimed (or would be in dry-run) */
  bytesReclaimed: number;
  /** Whether rotation was performed */
  rotated: boolean;
  /** Error message if rotation failed */
  error?: string;
}

/**
 * File info for sorting by age
 */
interface LogFileInfo {
  filename: string;
  filePath: string;
  mtime: Date;
  size: number;
}

/**
 * Resolve a path, replacing ~ with home directory
 */
function resolvePath(logPath: string): string {
  return logPath.replace("~", os.homedir());
}

/**
 * Get list of log files with metadata, sorted by modification time (oldest first)
 */
export function getLogFiles(logDir: string): LogFileInfo[] {
  const resolved = resolvePath(logDir);

  if (!fs.existsSync(resolved)) {
    return [];
  }

  const files = fs
    .readdirSync(resolved)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"));

  const fileInfos: LogFileInfo[] = files.map((filename) => {
    const filePath = path.join(resolved, filename);
    const stats = fs.statSync(filePath);
    return {
      filename,
      filePath,
      mtime: stats.mtime,
      size: stats.size,
    };
  });

  // Sort by modification time, oldest first
  return fileInfos.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
}

/**
 * Get statistics about the log directory
 *
 * @param logDir - Path to log directory
 * @param settings - Rotation settings for threshold comparison
 * @returns Log directory statistics
 */
export function getLogStats(
  logDir: string,
  settings: RotationSettings = DEFAULT_ROTATION_SETTINGS,
): LogStats {
  const files = getLogFiles(logDir);

  if (files.length === 0) {
    return {
      totalSizeBytes: 0,
      totalSizeMB: 0,
      fileCount: 0,
      oldestFile: null,
      newestFile: null,
      exceedsSizeThreshold: false,
      exceedsCountThreshold: false,
    };
  }

  const totalSizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  const totalSizeMB = totalSizeBytes / (1024 * 1024);

  return {
    totalSizeBytes,
    totalSizeMB,
    fileCount: files.length,
    oldestFile: files[0].filename,
    newestFile: files[files.length - 1].filename,
    exceedsSizeThreshold: totalSizeMB > settings.maxSizeMB,
    exceedsCountThreshold: files.length > settings.maxFiles,
  };
}

/**
 * Calculate which files need to be deleted to meet thresholds
 *
 * Applies a 10% buffer (stops at 90% of threshold) to prevent
 * immediate re-rotation on next run.
 *
 * @param logDir - Path to log directory
 * @param settings - Rotation settings
 * @returns List of files to delete (oldest first)
 */
export function getFilesToDelete(
  logDir: string,
  settings: RotationSettings,
): LogFileInfo[] {
  const files = getLogFiles(logDir);

  if (files.length === 0) {
    return [];
  }

  const stats = getLogStats(logDir, settings);

  // Check if rotation is needed
  if (!stats.exceedsSizeThreshold && !stats.exceedsCountThreshold) {
    return [];
  }

  // Target thresholds with 10% buffer (stop at 90%)
  const targetSizeBytes = settings.maxSizeMB * 1024 * 1024 * 0.9;
  const targetCount = Math.floor(settings.maxFiles * 0.9);

  const toDelete: LogFileInfo[] = [];
  let currentSize = stats.totalSizeBytes;
  let currentCount = stats.fileCount;

  // Delete oldest files first until under thresholds
  for (const file of files) {
    const sizeOk = currentSize <= targetSizeBytes;
    const countOk = currentCount <= targetCount;

    if (sizeOk && countOk) {
      break;
    }

    toDelete.push(file);
    currentSize -= file.size;
    currentCount--;
  }

  return toDelete;
}

/**
 * Rotate logs if needed (automatic rotation)
 *
 * Called after LogWriter.finalize() to clean up old logs.
 *
 * @param logDir - Path to log directory
 * @param settings - Rotation settings
 * @returns Rotation result
 */
export function rotateIfNeeded(
  logDir: string,
  settings: RotationSettings = DEFAULT_ROTATION_SETTINGS,
): RotationResult {
  if (!settings.enabled) {
    return {
      deletedFiles: [],
      deletedCount: 0,
      bytesReclaimed: 0,
      rotated: false,
    };
  }

  const resolved = resolvePath(logDir);
  const toDelete = getFilesToDelete(logDir, settings);

  if (toDelete.length === 0) {
    return {
      deletedFiles: [],
      deletedCount: 0,
      bytesReclaimed: 0,
      rotated: false,
    };
  }

  let bytesReclaimed = 0;
  const deletedFiles: string[] = [];

  for (const file of toDelete) {
    try {
      fs.unlinkSync(file.filePath);
      deletedFiles.push(file.filename);
      bytesReclaimed += file.size;
    } catch (err) {
      return {
        deletedFiles,
        deletedCount: deletedFiles.length,
        bytesReclaimed,
        rotated: deletedFiles.length > 0,
        error: `Failed to delete ${file.filename}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    deletedFiles,
    deletedCount: deletedFiles.length,
    bytesReclaimed,
    rotated: true,
  };
}

/**
 * Options for manual rotation
 */
export interface ManualRotateOptions {
  /** Dry run - don't actually delete files */
  dryRun?: boolean;
  /** Custom rotation settings */
  settings?: RotationSettings;
}

/**
 * Manual rotation triggered by CLI command
 *
 * Supports dry-run mode to preview what would be deleted.
 *
 * @param logDir - Path to log directory
 * @param options - Manual rotation options
 * @returns Rotation result
 */
export function manualRotate(
  logDir: string,
  options: ManualRotateOptions = {},
): RotationResult {
  const settings = options.settings ?? DEFAULT_ROTATION_SETTINGS;
  const toDelete = getFilesToDelete(logDir, settings);

  if (toDelete.length === 0) {
    return {
      deletedFiles: [],
      deletedCount: 0,
      bytesReclaimed: 0,
      rotated: false,
    };
  }

  // Dry run - just report what would be deleted
  if (options.dryRun) {
    return {
      deletedFiles: toDelete.map((f) => f.filename),
      deletedCount: toDelete.length,
      bytesReclaimed: toDelete.reduce((sum, f) => sum + f.size, 0),
      rotated: false,
    };
  }

  // Actual deletion
  return rotateIfNeeded(logDir, settings);
}

/**
 * Format bytes for human-readable display
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
