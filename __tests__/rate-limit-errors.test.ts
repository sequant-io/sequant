/**
 * Tests for structured rate-limit / billing errors (Issue #732).
 *
 * Covers AC-2 (RateLimitError/BillingError types + isRetryable), AC-3
 * (user-facing message names the real cause), and AC-7 (≥0.3.181 enrichment
 * with graceful gating).
 */

import { describe, it, expect } from "vitest";
import {
  SequantError,
  RateLimitError,
  BillingError,
  createRateLimitError,
  formatRateLimitMessage,
  isBillingFailure,
  isRateLimitFailureInfo,
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
