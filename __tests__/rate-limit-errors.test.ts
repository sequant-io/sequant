/**
 * Tests for structured rate-limit / billing errors (Issue #732).
 *
 * Covers AC-2 (RateLimitError/BillingError types + isRetryable), AC-3
 * (user-facing message names the real cause), and AC-7 (≥0.3.181 enrichment
 * with graceful gating).
 */

import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import {
  SequantError,
  RateLimitError,
  BillingError,
  createRateLimitError,
  formatRateLimitMessage,
  isBillingFailure,
  isRateLimitFailureInfo,
  isWaitableWindow,
  resetsAtToMs,
  type RateLimitInfoLike,
} from "../src/lib/errors.js";

// === AC-2: error types, metadata, isRetryable ===

describe("AC-2: RateLimitError / BillingError", () => {
  it("RateLimitError extends SequantError and is retryable", () => {
    const err = new RateLimitError("Rate limited", {
      resetsAt: 1_700_000_000,
      rateLimitType: "five_hour",
    });
    expect(err).toBeInstanceOf(SequantError);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.name).toBe("RateLimitError");
    expect(err.isRetryable).toBe(true);
    expect(err.metadata.resetsAt).toBe(1_700_000_000);
    expect(err.metadata.rateLimitType).toBe("five_hour");
  });

  it("BillingError extends SequantError and is NOT retryable", () => {
    const err = new BillingError("Out of credits", {
      overageDisabledReason: "out_of_credits",
    });
    expect(err).toBeInstanceOf(SequantError);
    expect(err).toBeInstanceOf(BillingError);
    expect(err.name).toBe("BillingError");
    expect(err.isRetryable).toBe(false);
    expect(err.metadata.overageDisabledReason).toBe("out_of_credits");
  });

  it("serializes name + metadata through toJSON", () => {
    const err = new BillingError("Out of credits — purchasable", {
      overageDisabledReason: "out_of_credits",
      canUserPurchaseCredits: true,
    });
    const json = JSON.parse(JSON.stringify(err.toJSON()));
    expect(json.name).toBe("BillingError");
    expect(json.isRetryable).toBe(false);
    expect(json.metadata.canUserPurchaseCredits).toBe(true);
  });
});

// === isBillingFailure / isRateLimitFailureInfo predicates ===

describe("rate-limit failure predicates", () => {
  it("isBillingFailure true for out_of_credits", () => {
    expect(isBillingFailure({ overageDisabledReason: "out_of_credits" })).toBe(
      true,
    );
  });

  it("isBillingFailure true for credits_required errorCode", () => {
    expect(isBillingFailure({ errorCode: "credits_required" })).toBe(true);
  });

  it("isBillingFailure false for a plain throttle", () => {
    expect(isBillingFailure({ status: "rejected" })).toBe(false);
  });

  it("isRateLimitFailureInfo true for rejected status", () => {
    expect(isRateLimitFailureInfo({ status: "rejected" })).toBe(true);
  });

  it("isRateLimitFailureInfo false for allowed_warning", () => {
    expect(isRateLimitFailureInfo({ status: "allowed_warning" })).toBe(false);
  });

  it("isRateLimitFailureInfo true for billing even when status allowed", () => {
    expect(
      isRateLimitFailureInfo({
        status: "allowed",
        overageDisabledReason: "out_of_credits",
      }),
    ).toBe(true);
  });
});

// === AC-3: user-facing message names the real cause ===

describe("AC-3: formatRateLimitMessage", () => {
  it("date-qualifies a reset on a different day (MM-DD HH:MM)", () => {
    // 1_700_000_000 (Nov 2023) is never "today", so the message must carry a
    // date — bare HH:MM would misread a multi-day (seven_day) window as today.
    const info: RateLimitInfoLike = {
      status: "rejected",
      resetsAt: 1_700_000_000, // seconds, far in the past
      rateLimitType: "seven_day",
    };
    const msg = formatRateLimitMessage(info);
    expect(msg).toMatch(/^Rate limited — resets at \d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("shows bare HH:MM for a same-day reset", () => {
    // A reset later today is unambiguous without a date.
    const today = new Date();
    today.setHours(14, 30, 0, 0);
    const msg = formatRateLimitMessage({
      status: "rejected",
      resetsAt: today.getTime(), // ms, today
    });
    expect(msg).toBe("Rate limited — resets at 14:30");
  });

  it("falls back to plain 'Rate limited' when resetsAt is absent", () => {
    expect(formatRateLimitMessage({ status: "rejected" })).toBe("Rate limited");
  });

  it("names out-of-credits for billing failures", () => {
    expect(
      formatRateLimitMessage({ overageDisabledReason: "out_of_credits" }),
    ).toBe("Out of credits");
  });

  it("treats epoch-ms resetsAt the same as epoch-seconds", () => {
    const seconds = 1_700_000_000;
    const secMsg = formatRateLimitMessage({
      status: "rejected",
      resetsAt: seconds,
    });
    const msMsg = formatRateLimitMessage({
      status: "rejected",
      resetsAt: seconds * 1000,
    });
    expect(secMsg).toBe(msMsg);
  });
});

// === AC-7: ≥0.3.181 enrichment + graceful gating ===

describe("AC-7: createRateLimitError + 0.3.181 enrichment", () => {
  it("builds BillingError for out_of_credits and enriches as purchasable", () => {
    const err = createRateLimitError({
      status: "rejected",
      overageDisabledReason: "out_of_credits",
      canUserPurchaseCredits: true,
      hasChargeableSavedPaymentMethod: false,
    });
    expect(err).toBeInstanceOf(BillingError);
    expect(err.isRetryable).toBe(false);
    expect(err.message).toBe("Out of credits — purchasable");
    expect(err.metadata.canUserPurchaseCredits).toBe(true);
    expect(err.metadata.hasChargeableSavedPaymentMethod).toBe(false);
  });

  it("distinguishes a hard limit when purchasing is disallowed", () => {
    const err = createRateLimitError({
      status: "rejected",
      errorCode: "credits_required",
      canUserPurchaseCredits: false,
    });
    expect(err).toBeInstanceOf(BillingError);
    expect(err.message).toBe("Out of credits — hard limit");
  });

  it("gates gracefully when 0.3.181 fields are absent (generic message)", () => {
    const err = createRateLimitError({
      status: "rejected",
      overageDisabledReason: "out_of_credits",
    });
    expect(err).toBeInstanceOf(BillingError);
    expect(err.message).toBe("Out of credits");
    expect(err.metadata.canUserPurchaseCredits).toBeUndefined();
  });

  it("builds a retryable RateLimitError for transient throttles", () => {
    const err = createRateLimitError({
      status: "rejected",
      resetsAt: 1_700_000_000,
      rateLimitType: "five_hour",
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.isRetryable).toBe(true);
    // Past timestamp → date-qualified.
    expect(err.message).toMatch(
      /^Rate limited — resets at \d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });
});

// === #860: waitable-window vs terminal-billing classification ===

describe("#860 isWaitableWindow", () => {
  // A fixed instant keeps every case deterministic; payload times are derived
  // from it rather than the real clock.
  const NOW = 1_784_900_000_000; // epoch ms
  const FUTURE_S = Math.floor(NOW / 1000) + 3 * 3600; // +3h, epoch seconds
  const PAST_S = Math.floor(NOW / 1000) - 3600; // -1h, epoch seconds

  it("recognizes five_hour with a future resetsAt", () => {
    expect(
      isWaitableWindow({ rateLimitType: "five_hour", resetsAt: FUTURE_S }, NOW),
    ).toBe(true);
  });

  it("prefix-matches seven_day model-qualified variants", () => {
    expect(
      isWaitableWindow(
        { rateLimitType: "seven_day_opus", resetsAt: FUTURE_S },
        NOW,
      ),
    ).toBe(true);
  });

  it("accepts an epoch-ms resetsAt via the shared unit heuristic", () => {
    expect(
      isWaitableWindow(
        { rateLimitType: "five_hour", resetsAt: FUTURE_S * 1000 },
        NOW,
      ),
    ).toBe(true);
  });

  it("rejects a past resetsAt — nothing to wait for", () => {
    expect(
      isWaitableWindow({ rateLimitType: "five_hour", resetsAt: PAST_S }, NOW),
    ).toBe(false);
  });

  it("rejects a missing resetsAt", () => {
    expect(isWaitableWindow({ rateLimitType: "five_hour" }, NOW)).toBe(false);
  });

  it("AC-3: rejects an unrecognized window type (fail closed)", () => {
    expect(
      isWaitableWindow({ rateLimitType: "overage", resetsAt: FUTURE_S }, NOW),
    ).toBe(false);
  });

  it("AC-3: rejects a missing rateLimitType (fail closed)", () => {
    expect(isWaitableWindow({ resetsAt: FUTURE_S }, NOW)).toBe(false);
  });
});

describe("#860 narrowed isBillingFailure + createRateLimitError", () => {
  const NOW = 1_784_900_000_000;
  const FUTURE_S = Math.floor(NOW / 1000) + 3 * 3600;
  const PAST_S = Math.floor(NOW / 1000) - 3600;

  /** The exact shape of all 26 captured subscription-window payloads. */
  const capturedShape: RateLimitInfoLike = {
    resetsAt: FUTURE_S,
    rateLimitType: "five_hour",
    overageDisabledReason: "out_of_credits",
  };

  it("AC-1: out_of_credits + live five-hour window is NOT a billing failure", () => {
    expect(isBillingFailure(capturedShape, NOW)).toBe(false);
  });

  it("AC-1: the captured shape becomes a retryable RateLimitError with metadata intact", () => {
    const err = createRateLimitError(capturedShape, NOW);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.isRetryable).toBe(true);
    expect(err.metadata.resetsAt).toBe(FUTURE_S);
    expect(err.metadata.rateLimitType).toBe("five_hour");
    expect(err.metadata.overageDisabledReason).toBe("out_of_credits");
    // The message names the reopening window, not a wallet failure.
    expect(err.message).toMatch(/^Rate limited — resets at /);
  });

  it("AC-2: an explicit credits_required stays terminal even beside window evidence", () => {
    const info: RateLimitInfoLike = {
      ...capturedShape,
      errorCode: "credits_required",
    };
    expect(isBillingFailure(info, NOW)).toBe(true);
    const err = createRateLimitError(info, NOW);
    expect(err).toBeInstanceOf(BillingError);
    expect(err.message).toBe("Out of credits");
  });

  it("AC-2: out_of_credits with a PAST resetsAt stays terminal with the existing message", () => {
    const info: RateLimitInfoLike = { ...capturedShape, resetsAt: PAST_S };
    expect(isBillingFailure(info, NOW)).toBe(true);
    expect(createRateLimitError(info, NOW)).toBeInstanceOf(BillingError);
    expect(formatRateLimitMessage(info, NOW)).toBe("Out of credits");
  });

  it("AC-2: out_of_credits with no resetsAt stays terminal", () => {
    expect(
      isBillingFailure({ overageDisabledReason: "out_of_credits" }, NOW),
    ).toBe(true);
  });

  it("AC-3: out_of_credits + unrecognized window type fails closed to terminal", () => {
    const info: RateLimitInfoLike = {
      resetsAt: FUTURE_S,
      rateLimitType: "overage",
      overageDisabledReason: "out_of_credits",
    };
    expect(isBillingFailure(info, NOW)).toBe(true);
    expect(createRateLimitError(info, NOW)).toBeInstanceOf(BillingError);
  });

  it("retention is unchanged: the captured shape still counts as failure info", () => {
    // isRateLimitFailureInfo keys on the raw billing markers, not the narrowed
    // classification — otherwise the driver would drop the very events #860
    // exists to keep (their `status` field is unproven in the captures).
    expect(isRateLimitFailureInfo(capturedShape)).toBe(true);
  });
});

// === #860 AC-4: all 26 captured payloads gate the classification ===

describe("#860 AC-4: captured payload fixtures", () => {
  interface CapturedPayload {
    project: string;
    sourceFile: string;
    errorType: string;
    errorMetadata: {
      resetsAt: number;
      rateLimitType: string;
      overageDisabledReason: string;
    };
  }

  const payloads: CapturedPayload[] = JSON.parse(
    readFileSync(
      new URL("./fixtures/rate-limit-payloads-860.json", import.meta.url),
      "utf8",
    ),
  );

  it("commits all 26 occurrences (22 ad-motion + 4 matcha-maps)", () => {
    expect(payloads).toHaveLength(26);
    expect(payloads.filter((p) => p.project === "ad-motion")).toHaveLength(22);
    expect(payloads.filter((p) => p.project === "matcha-maps")).toHaveLength(4);
  });

  it("every capture was recorded as the misclassification under repair", () => {
    // Provenance guard: each fixture entry is a real pre-#860 BillingError
    // whose metadata carries the five-hour window shape.
    for (const p of payloads) {
      expect(p.errorType).toBe("BillingError");
      expect(p.errorMetadata.rateLimitType).toBe("five_hour");
      expect(p.errorMetadata.overageDisabledReason).toBe("out_of_credits");
      expect(typeof p.errorMetadata.resetsAt).toBe("number");
    }
  });

  it("AC-1/AC-4: every captured payload classifies as a waitable RateLimitError while its window is live", () => {
    for (const p of payloads) {
      // Pin `now` one hour before each payload's reset so the window is live,
      // exactly as it was when the failure was recorded.
      const now = resetsAtToMs(p.errorMetadata.resetsAt) - 3600_000;
      expect(isWaitableWindow(p.errorMetadata, now)).toBe(true);
      expect(isBillingFailure(p.errorMetadata, now)).toBe(false);
      const err = createRateLimitError(p.errorMetadata, now);
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.metadata.resetsAt).toBe(p.errorMetadata.resetsAt);
    }
  });

  it("AC-2: the same payloads are terminal once their window has passed", () => {
    for (const p of payloads) {
      const now = resetsAtToMs(p.errorMetadata.resetsAt) + 3600_000;
      expect(isBillingFailure(p.errorMetadata, now)).toBe(true);
      expect(createRateLimitError(p.errorMetadata, now)).toBeInstanceOf(
        BillingError,
      );
    }
  });
});
