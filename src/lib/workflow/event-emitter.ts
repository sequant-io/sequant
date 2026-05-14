/**
 * Typed workflow event emitter (#504).
 *
 * Provides a strongly-typed `EventEmitter` for `RunOrchestrator` lifecycle
 * events. Multiple consumers (TUI, MCP server, future webhooks) can subscribe
 * without the orchestrator knowing they exist.
 *
 * Design notes:
 * - Wraps Node's built-in `node:events.EventEmitter` (no third-party deps per
 *   AC-2). The typing is compile-time only — at runtime this is a vanilla
 *   `EventEmitter`.
 * - `emit()` is overridden to invoke listeners through `Promise.allSettled`
 *   so a slow or throwing listener can never crash the pipeline (AC-5). The
 *   override returns `Promise<void>` so callers in critical paths can `await`
 *   the wrapper; fire-and-forget callers (e.g. `progress` ticks) just drop
 *   the returned promise.
 * - The orchestrator coexists with the existing `onProgress` callback rather
 *   than replacing it. `onProgress` remains the synchronous TUI render hook;
 *   events are the async multi-subscriber surface. Consolidation is an
 *   intentional non-goal (see issue #504, descope comment 2026-04-09).
 *
 * @module
 */

import { EventEmitter } from "node:events";
import type { QaVerdict } from "./run-log-schema.js";

/** Issue lifecycle status surfaced through `issue_status_changed`. */
export type IssueEventStatus = "queued" | "running" | "passed" | "failed";

/**
 * Base fields present on every workflow event payload.
 *
 * Payloads are JSON-serializable: only primitives and plain records, no
 * class instances or circular references. This keeps MCP/webhook consumers
 * cheap (`JSON.stringify(payload)` is always safe).
 */
export interface BaseEventPayload {
  /** GitHub issue number this event is about. */
  issueNumber: number;
  /** ISO 8601 timestamp captured when the event was emitted. */
  timestamp: string;
}

/** Payload for `run_started` / `run_completed`. */
export interface RunEventPayload extends BaseEventPayload {
  /** Wall-clock duration in seconds. Present on `run_completed` only. */
  duration?: number;
  /** Aggregate success across all phases. Present on `run_completed` only. */
  success?: boolean;
}

/** Payload for `phase_started`. */
export interface PhaseStartedPayload extends BaseEventPayload {
  /** Phase name (e.g. `spec`, `exec`, `qa`). */
  phase: string;
  /** Outer-loop iteration (1-based). Present when running under quality-loop. */
  iteration?: number;
}

/** Payload for `phase_completed`. */
export interface PhaseCompletedPayload extends BaseEventPayload {
  phase: string;
  /** Phase wall-clock duration in seconds (matches `PhaseLog.durationSeconds`). */
  duration: number;
  iteration?: number;
}

/** Payload for `phase_failed`. */
export interface PhaseFailedPayload extends BaseEventPayload {
  phase: string;
  duration?: number;
  /** Stringified error message. Class instances are flattened to strings. */
  error: string;
  iteration?: number;
}

/** Payload for `issue_status_changed`. */
export interface IssueStatusChangedPayload extends BaseEventPayload {
  /** Previous lifecycle status. */
  from: IssueEventStatus;
  /** New lifecycle status. */
  to: IssueEventStatus;
}

/** Payload for `qa_verdict`. Emitted once per QA phase that produces a verdict. */
export interface QaVerdictPayload extends BaseEventPayload {
  phase: "qa";
  verdict: QaVerdict;
}

/** Payload for `progress` (sub-phase activity ping, ~10 Hz). */
export interface ProgressPayload extends BaseEventPayload {
  phase: string;
  /** Short one-line snippet for the dashboard activity row. */
  text?: string;
}

/**
 * Discriminated map of event name → payload type. Add new events by
 * extending this map; the `emit`/`on`/`off` overloads below pick them up
 * automatically. Reject `string` index signatures so consumers cannot
 * subscribe to typo'd event names without a TypeScript error (AC-1, AC-2).
 */
export interface WorkflowEvents {
  run_started: RunEventPayload;
  run_completed: RunEventPayload;
  phase_started: PhaseStartedPayload;
  phase_completed: PhaseCompletedPayload;
  phase_failed: PhaseFailedPayload;
  issue_status_changed: IssueStatusChangedPayload;
  qa_verdict: QaVerdictPayload;
  progress: ProgressPayload;
}

/** Listener signature for a given event name. */
export type WorkflowEventListener<E extends keyof WorkflowEvents> = (
  payload: WorkflowEvents[E],
) => void | Promise<void>;

/**
 * Build an ISO 8601 timestamp for an event payload. Centralized so tests can
 * inject a fixed clock via the constructor.
 *
 * @internal
 */
export type Clock = () => Date;

const defaultClock: Clock = () => new Date();

/**
 * Typed wrapper around `node:events.EventEmitter`.
 *
 * Type parameter `E` is the event-name → payload map. `on`, `off`, and
 * `emit` are all narrowed to that map; passing an unknown event name fails
 * compilation (AC-2).
 */
export class WorkflowEventEmitter {
  private readonly inner = new EventEmitter();
  private readonly clock: Clock;
  private readonly onListenerError: (eventName: string, error: unknown) => void;

  constructor(opts?: {
    clock?: Clock;
    /**
     * Invoked whenever a listener throws or rejects. Defaults to a no-op
     * because rejection logging is the orchestrator's call (it knows whether
     * `verbose` is enabled). Tests use this to assert isolation.
     */
    onListenerError?: (eventName: string, error: unknown) => void;
  }) {
    this.clock = opts?.clock ?? defaultClock;
    this.onListenerError = opts?.onListenerError ?? (() => {});
    // Effectively no listener cap — multiple consumers (TUI, MCP, log writer
    // in the future) can subscribe to popular events like `progress`.
    this.inner.setMaxListeners(0);
  }

  /** Register a listener for the given event. */
  on<E extends keyof WorkflowEvents>(
    event: E,
    listener: WorkflowEventListener<E>,
  ): this {
    this.inner.on(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  /** Remove a previously registered listener. */
  off<E extends keyof WorkflowEvents>(
    event: E,
    listener: WorkflowEventListener<E>,
  ): this {
    this.inner.off(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  /** Number of listeners attached to `event`. Useful in tests. */
  listenerCount<E extends keyof WorkflowEvents>(event: E): number {
    return this.inner.listenerCount(event as string);
  }

  /** Drop all listeners. Call from `RunOrchestrator` teardown to avoid leaks. */
  removeAllListeners(): this {
    this.inner.removeAllListeners();
    return this;
  }

  /**
   * Emit an event. Listeners are invoked through `Promise.allSettled` so a
   * single misbehaving subscriber cannot crash the pipeline (AC-5).
   *
   * Returns `Promise<void>` so critical-path callers may `await`. Fire-and-
   * forget callers (`progress`, etc.) ignore the returned promise — the
   * `Promise.allSettled` swallowing handles unhandled rejection warnings.
   *
   * The `timestamp` field on the payload is populated automatically when
   * absent so call sites stay terse.
   */
  emit<E extends keyof WorkflowEvents>(
    event: E,
    payload: Omit<WorkflowEvents[E], "timestamp"> &
      Partial<Pick<WorkflowEvents[E], "timestamp">>,
  ): Promise<void> {
    const finalPayload = {
      ...payload,
      timestamp: payload.timestamp ?? this.clock().toISOString(),
    } as WorkflowEvents[E];

    const listeners = this.inner.listeners(event as string) as Array<
      WorkflowEventListener<E>
    >;
    if (listeners.length === 0) {
      return Promise.resolve();
    }

    // Wrap each listener in `Promise.resolve().then(() => listener(payload))`
    // so synchronous throws are reified into rejections before
    // `Promise.allSettled` runs. Without the resolve-then trampoline, a
    // synchronous throw inside a non-async listener would propagate
    // immediately and bypass `allSettled`.
    const settled = Promise.allSettled(
      listeners.map((listener) =>
        Promise.resolve().then(() => listener(finalPayload)),
      ),
    );

    return settled.then((results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          try {
            this.onListenerError(event as string, r.reason);
          } catch {
            /* swallow — error handler must not propagate */
          }
        }
      }
    });
  }
}
