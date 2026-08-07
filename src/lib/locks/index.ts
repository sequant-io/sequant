/**
 * Public surface for the issue-level concurrency lock (#625) and the
 * checkout-scoped lock (#901).
 */

export {
  CheckoutLock,
  formatCheckoutLockedMessage,
  isCheckoutOwner,
} from "./checkout-lock.js";
export type { CheckoutLockOptions } from "./checkout-lock.js";
export {
  LockManager,
  classifyStaleness,
  defaultIsPidAlive,
  formatLockedMessage,
  isOrchestratorMode,
  resolveLocksDir,
  resolveMaxLockAgeMs,
} from "./lock-manager.js";
export type { LockManagerOptions } from "./lock-manager.js";
export {
  CHECKOUT_LOCK_FILENAME,
  CheckoutLockFileSchema,
  DEFAULT_LOCKS_DIR,
  DEFAULT_MAX_LOCK_AGE_MS,
  DEFAULT_STALE_AGE_MS,
  LockFileSchema,
} from "./types.js";
export type {
  AcquireResult,
  CheckoutAcquireResult,
  CheckoutHolderIdentity,
  CheckoutLockFile,
  CheckoutLockListing,
  LockFile,
  LockListing,
  SignalOtherResult,
  SignalReason,
  StaleReason,
} from "./types.js";
