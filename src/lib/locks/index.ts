/**
 * Public surface for the issue-level concurrency lock (#625).
 */

export {
  LockManager,
  classifyStaleness,
  defaultIsPidAlive,
  formatLockedMessage,
  isOrchestratorMode,
  resolveLocksDir,
} from "./lock-manager.js";
export type { LockManagerOptions } from "./lock-manager.js";
export {
  DEFAULT_LOCKS_DIR,
  DEFAULT_STALE_AGE_MS,
  LockFileSchema,
} from "./types.js";
export type {
  AcquireResult,
  LockFile,
  LockListing,
  SignalOtherResult,
  SignalReason,
} from "./types.js";
