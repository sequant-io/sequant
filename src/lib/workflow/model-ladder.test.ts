/**
 * #971 — model escalation ladder on capability-bound non-convergence.
 *
 * Test names are prefixed `971 AC-N` so each AC's declared verify command
 * (`npx vitest run src/lib/workflow/model-ladder.test.ts -t "971 AC-N"`)
 * selects exactly its own block. `-t` matches a substring of the FULL name
 * (describe + it), so the prefix lives on the describe.
 *
 * Where an AC names "the dispatch site", the assertion is on what the dispatch
 * site actually hands the driver — `ExecutionConfig.phasePolicies[phase].model`,
 * the field `phase-executor.ts` turns into `AgentExecutionConfig.model` — for
 * both the run path (`runIssueWithLogging`'s quality loop, exercised here
 * through the same resolver call the loop makes) and the ready-gate path
 * (`runReadyGate` with an injected `runPhase`, the real loop). The end-to-end
 * hop from `phasePolicies` into the SDK's `query()` options is covered by
 * `phase-executor.model-ladder.test.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  withEscalatedModel,
  createLadderState,
  canEscalateFurther,
  detectCapabilityBoundTrigger,
  checkMarkerIntegrity,
  resolveNextRung,
  startingRungFor,
  isLadderConfigured,
  buildEscalationMarkerFields,
  type LadderState,
} from "./model-ladder.js";
import { withEscalatedEffort } from "./effort-escalation.js";
import {
  buildExecutionConfig,
  resolveRunOptions,
  resolveModelLadder,
} from "./config-resolver.js";
import { runReadyGate, type RunReadyGateOptions } from "./ready-gate.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { ExecutionConfig, PhaseResult, RunOptions } from "./types.js";
import type { PhaseMarker } from "./state-schema.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { SequantSettings } from "../settings.js";

const LADDER = ["sonnet", "opus", "fable"];

function settingsWith(run: Partial<SequantSettings["run"]>): SequantSettings {
  return {
    ...DEFAULT_SETTINGS,
    run: { ...DEFAULT_SETTINGS.run, ...run },
  } as SequantSettings;
}

function resolve(
  options: Partial<RunOptions>,
  run: Partial<SequantSettings["run"]> = {},
): ExecutionConfig {
  const settings = settingsWith(run);
  return buildExecutionConfig(
    resolveRunOptions(options as RunOptions, settings),
    settings,
    1,
  );
}

function configWith(overrides: Partial<ExecutionConfig>): ExecutionConfig {
  return { ...DEFAULT_CONFIG, mcp: false, ...overrides };
}

/** The model a dispatch would send for `phase`, or `undefined` when unset. */
function dispatchedModel(
  config: ExecutionConfig,
  phase: string,
): string | undefined {
  return config.phasePolicies?.[phase]?.model;
}

/** An intact `qa` marker at `sha` — the AC-8 happy path. */
function marker(overrides: Partial<PhaseMarker> = {}): PhaseMarker {
  return {
    phase: "qa",
    status: "failed",
    timestamp: "2026-09-08T00:00:00.000Z",
    commitSHA: "sha-1",
    ...overrides,
  } as PhaseMarker;
}

// ---------------------------------------------------------------------------

describe("971 AC-1: parse + precedence + off-by-default", () => {
  it("CLI --model-ladder beats settings.run.modelLadder", () => {
    const config = resolve(
      { modelLadder: "opus,fable" },
      { modelLadder: ["sonnet", "opus", "fable"] },
    );
    expect(config.modelLadder).toEqual(["opus", "fable"]);
  });

  it("settings.run.modelLadder applies when no CLI flag is given", () => {
    const config = resolve({}, { modelLadder: ["sonnet", "opus"] });
    expect(config.modelLadder).toEqual(["sonnet", "opus"]);
  });

  it("trims whitespace around comma-separated CLI rungs", () => {
    expect(
      resolveModelLadder(" sonnet , opus ", undefined).modelLadder,
    ).toEqual(["sonnet", "opus"]);
  });

  it("rejects an empty --model-ladder rather than silently resolving to no ladder", () => {
    expect(() => resolveModelLadder("  ,  ", undefined)).toThrow(
      /Malformed --model-ladder/,
    );
  });

  it("resolves role: entries through the #975 role resolver and records the pre-resolution strings (OQ-5)", () => {
    const resolved = resolveModelLadder(
      "role:fast,role:strong",
      undefined,
      { fast: "sonnet", strong: "opus" },
      "claude-code",
    );
    expect(resolved.modelLadder).toEqual(["sonnet", "opus"]);
    expect(resolved.modelLadderRequested).toEqual(["role:fast", "role:strong"]);
  });

  it("keeps raw model strings legal and records no `requested` trail for them (#975 AC-3)", () => {
    const resolved = resolveModelLadder("sonnet,opus", undefined);
    expect(resolved.modelLadder).toEqual(["sonnet", "opus"]);
    expect("modelLadderRequested" in resolved).toBe(false);
  });

  it("with no ladder configured, the resolved ExecutionConfig has NO ladder key at all", () => {
    const config = resolve({});
    // Key-presence, not truthiness: an `undefined` value would still be a new
    // key on the object and would break the deep-equal below.
    expect("modelLadder" in config).toBe(false);
    expect("modelLadderRequested" in config).toBe(false);
  });

  it("an empty settings array resolves to absent — `[]` is not a usable ladder", () => {
    const config = resolve({}, { modelLadder: [] });
    expect("modelLadder" in config).toBe(false);
  });

  it("with no ladder, a retried phase's dispatch config DEEP-EQUALS the #914/#915 pre-change shape", () => {
    // The pre-change shape: exactly what #915's dispatch site produced before
    // the ladder existed — `withEscalatedEffort` applied to the resolved
    // config, and nothing else.
    const config = resolve({ escalateEffort: true, models: "qa=sonnet" });
    const preChange = withEscalatedEffort(config, "qa", true).config;

    const state = createLadderState();
    const postChange = withEscalatedModel(
      preChange,
      "qa",
      "LOOP_NO_DIFF", // even WITH a trigger: no ladder ⇒ nothing to escalate to
      state,
    ).config;

    expect(postChange).toEqual(preChange);
    // Stronger than deep-equal: the same object, so no copy was made and no
    // key was added or removed anywhere in the tree.
    expect(postChange).toBe(preChange);
    expect(state.rungByPhase.size).toBe(0);
  });

  it("isLadderConfigured is false for absent and empty ladders, true otherwise", () => {
    expect(isLadderConfigured(configWith({}))).toBe(false);
    expect(isLadderConfigured(configWith({ modelLadder: [] }))).toBe(false);
    expect(isLadderConfigured(configWith({ modelLadder: LADDER }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("971 AC-2: a capability-bound trigger dispatches the next rung", () => {
  it("LOOP_NO_DIFF on the prior attempt dispatches the next rung (run path)", () => {
    const config = configWith({ modelLadder: LADDER });
    const state = createLadderState();

    const { config: dispatch, record } = withEscalatedModel(
      config,
      "exec",
      "LOOP_NO_DIFF",
      state,
    );

    expect(dispatchedModel(dispatch, "exec")).toBe("opus");
    expect(record).toMatchObject({
      phase: "exec",
      rung: 1,
      base: "sonnet",
      escalated: "opus",
      trigger: "LOOP_NO_DIFF",
    });
  });

  it("SAME_SHA_NO_PROGRESS on the prior attempt dispatches the next rung", () => {
    const config = configWith({ modelLadder: LADDER });
    const { config: dispatch } = withEscalatedModel(
      config,
      "qa",
      "SAME_SHA_NO_PROGRESS",
      createLadderState(),
    );
    expect(dispatchedModel(dispatch, "qa")).toBe("opus");
  });

  it("detects LOOP_NO_DIFF from a snapshot pair that shows no diff", () => {
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      loopProgress: {
        progressed: false,
        reason: "LOOP_NO_DIFF",
        message: "no diff",
      },
    });
    expect(decision.trigger).toBe("LOOP_NO_DIFF");
  });

  it("detects SAME_SHA_NO_PROGRESS from a failed marker at HEAD with a clean worktree", () => {
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      currentSha: "sha-1",
      isDirty: false,
      lastMarker: marker({ commitSHA: "sha-1" }),
      markerPhase: "qa",
    });
    expect(decision.trigger).toBe("SAME_SHA_NO_PROGRESS");
  });

  it("never escalates a first attempt — the ladder acts on evidence, never speculatively", () => {
    expect(detectCapabilityBoundTrigger({ isRetry: false }).trigger).toBeNull();
  });

  it("ready-gate path: a no-diff fix loop re-dispatches qa one rung up", async () => {
    // The gate's own loop, driven end to end: QA fails, the fix loop runs and
    // produces no diff, and (because a ladder is configured and a rung
    // remains) the gate continues instead of halting — the OQ-1 change that
    // makes this AC reachable at all.
    const dispatched: Array<{ phase: string; model?: string }> = [];
    const opts: RunReadyGateOptions = {
      issueNumber: 971,
      worktreePath: "/tmp/worktree-971",
      policy: "ac",
      maxIterations: 3,
      config: configWith({ modelLadder: LADDER }),
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      // Constant snapshot ⇒ every fix loop shows no diff ⇒ LOOP_NO_DIFF.
      snapshotFn: () => ({ sha: "sha-frozen", dirty: [] }),
      runPhase: (phase, config) => {
        dispatched.push({ phase, model: dispatchedModel(config, phase) });
        return Promise.resolve({
          phase,
          success: true,
          verdict: phase === "qa" ? "AC_NOT_MET" : undefined,
        } as PhaseResult);
      },
    };

    const result = await runReadyGate(opts);

    const qaModels = dispatched
      .filter((d) => d.phase === "qa")
      .map((d) => d.model);
    // Pass 1 runs at the unescalated base (no key set); passes 2 and 3 run one
    // rung up each, after each no-diff fix loop.
    expect(qaModels).toEqual([undefined, "opus", "fable"]);
    // qa→opus, loop→opus (iteration 2), qa→fable (iteration 3). Iteration 3's
    // fix loop never runs — the gate returns MAX_ITERATIONS after its QA pass —
    // so `loop` never reaches the top rung.
    expect(
      result.modelEscalations.map((e) => `${e.phase}:${e.escalated}`),
    ).toEqual(["qa:opus", "loop:opus", "qa:fable"]);
  });

  it("ready-gate path: with NO ladder configured, LOOP_NO_DIFF stays terminal (pre-#971 behaviour)", async () => {
    let qaCalls = 0;
    const opts: RunReadyGateOptions = {
      issueNumber: 971,
      worktreePath: "/tmp/worktree-971",
      policy: "ac",
      maxIterations: 3,
      config: configWith({}),
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      snapshotFn: () => ({ sha: "sha-frozen", dirty: [] }),
      runPhase: (phase) => {
        if (phase === "qa") qaCalls++;
        return Promise.resolve({
          phase,
          success: true,
          verdict: phase === "qa" ? "AC_NOT_MET" : undefined,
        } as PhaseResult);
      },
    };

    const result = await runReadyGate(opts);

    expect(result.reason).toBe("LOOP_NO_DIFF");
    expect(qaCalls).toBe(1);
    expect(result.modelEscalations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("971 AC-3: advancing SHAs with repeated QA failure never change the model", () => {
  it("three iterations with new SHAs and failing verdicts hold the model option constant", async () => {
    const dispatched: Array<{ phase: string; model?: string }> = [];
    let snapshots = 0;
    const opts: RunReadyGateOptions = {
      issueNumber: 971,
      worktreePath: "/tmp/worktree-971",
      policy: "ac",
      maxIterations: 3,
      config: configWith({ modelLadder: LADDER }),
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      // A fresh SHA on every call ⇒ every fix loop shows a real diff. This is
      // the divergence-suspect fingerprint: progress, but still failing.
      snapshotFn: () => ({ sha: `sha-${snapshots++}`, dirty: [] }),
      runPhase: (phase, config) => {
        dispatched.push({ phase, model: dispatchedModel(config, phase) });
        return Promise.resolve({
          phase,
          success: true,
          verdict: phase === "qa" ? "AC_NOT_MET" : undefined,
        } as PhaseResult);
      },
    };

    const result = await runReadyGate(opts);

    expect(result.iterations).toBe(3);
    // Every dispatch, qa and loop alike, ran on the unescalated model.
    expect(dispatched.every((d) => d.model === undefined)).toBe(true);
    expect(result.modelEscalations).toEqual([]);
    expect(result.reason).toBe("MAX_ITERATIONS");
  });

  it("the trigger detector calls advancing-SHA failure divergence-suspect, not capability-bound", () => {
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      loopProgress: {
        progressed: true,
        message: "HEAD advanced sha-1 → sha-2.",
      },
    });
    expect(decision.trigger).toBeNull();
    expect(decision.reason).toMatch(/divergence-suspect/);
  });
});

// ---------------------------------------------------------------------------

describe("971 AC-5: composes with #915 — effort first, model later, never both", () => {
  it("retry 1 escalates effort only; a later capability-bound retry escalates the model only", () => {
    const config = configWith({
      modelLadder: LADDER,
      effortEscalation: true,
      phasePolicies: { qa: { effort: "high" } },
    });
    const state = createLadderState();

    // The exact composition both dispatch sites use: a trigger SUPPRESSES the
    // effort bump, which is what makes "both on one iteration" unrepresentable
    // rather than merely untested.
    const dispatch = (trigger: "LOOP_NO_DIFF" | null, isRetry: boolean) => {
      const effort = withEscalatedEffort(
        config,
        "qa",
        isRetry && trigger === null,
      );
      const model = withEscalatedModel(effort.config, "qa", trigger, state);
      return {
        effortChanged: effort.record !== undefined,
        modelChanged: model.record !== undefined,
        config: model.config,
      };
    };

    // Iteration 1 — first attempt: neither.
    const it1 = dispatch(null, false);
    expect(it1).toMatchObject({ effortChanged: false, modelChanged: false });

    // Iteration 2 — a plain retry with no no-progress evidence: effort only.
    const it2 = dispatch(null, true);
    expect(it2).toMatchObject({ effortChanged: true, modelChanged: false });
    expect(it2.config.phasePolicies?.qa.effort).toBe("xhigh");
    expect(dispatchedModel(it2.config, "qa")).toBeUndefined();

    // Iteration 3 — the retry IS capability-bound: model rung, no effort bump.
    const it3 = dispatch("LOOP_NO_DIFF", true);
    expect(it3).toMatchObject({ effortChanged: false, modelChanged: true });
    expect(it3.config.phasePolicies?.qa.effort).toBe("high"); // base, unbumped
    expect(dispatchedModel(it3.config, "qa")).toBe("opus");
  });

  it("no iteration of the real ready-gate loop shows effort and model both changing", async () => {
    const seen: Array<{
      effort?: string;
      model?: string;
      modelChanged: boolean;
      effortChanged: boolean;
    }> = [];
    const opts: RunReadyGateOptions = {
      issueNumber: 971,
      worktreePath: "/tmp/worktree-971",
      policy: "ac",
      maxIterations: 3,
      config: configWith({
        modelLadder: LADDER,
        effortEscalation: true,
        phasePolicies: { qa: { effort: "high" }, loop: { effort: "high" } },
      }),
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      snapshotFn: () => ({ sha: "sha-frozen", dirty: [] }),
      runPhase: (phase, config) => {
        seen.push({
          effort: config.phasePolicies?.[phase]?.effort,
          model: dispatchedModel(config, phase),
          // `modelEscalation` is set by `withEscalatedModel` only on a
          // dispatch that sits above its starting rung, and `trigger` is
          // `"STICKY"` when the rung was merely re-applied — so a genuine
          // rung ADVANCE is the non-sticky case.
          modelChanged:
            config.modelEscalation !== undefined &&
            config.modelEscalation.trigger !== "STICKY",
          effortChanged: config.phasePolicies?.[phase]?.effort === "xhigh",
        });
        return Promise.resolve({
          phase,
          success: true,
          verdict: phase === "qa" ? "AC_NOT_MET" : undefined,
        } as PhaseResult);
      },
    };

    await runReadyGate(opts);

    // Asserted on what CHANGED this dispatch, not on what is merely present.
    // A sticky rung means a later iteration can legitimately run at an
    // already-reached model WHILE its effort bumps — that is AC-6's
    // stickiness, not an AC-5 violation, and a presence-based filter would
    // flag it. `record`-presence is exactly "this dispatch changed it".
    const bothChanged = seen.filter((s) => s.effortChanged && s.modelChanged);
    expect(bothChanged).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("971 AC-6: sticky, no skipping, no overflow", () => {
  it("an escalated rung persists across later dispatches that carry no trigger", () => {
    const config = configWith({ modelLadder: LADDER });
    const state = createLadderState();

    const escalated = withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state);
    expect(dispatchedModel(escalated.config, "qa")).toBe("opus");

    // Two further dispatches with NO trigger: the rung holds, and neither
    // emits a record (nothing *changed* — it merely stayed).
    for (const _ of [1, 2]) {
      const sticky = withEscalatedModel(config, "qa", null, state);
      expect(dispatchedModel(sticky.config, "qa")).toBe("opus");
      expect(sticky.record).toBeUndefined();
    }
  });

  it("stickiness is per phase — one phase's rung never moves another's", () => {
    const config = configWith({ modelLadder: LADDER });
    const state = createLadderState();

    withEscalatedModel(config, "exec", "LOOP_NO_DIFF", state);
    const qa = withEscalatedModel(config, "qa", null, state);

    expect(state.rungByPhase.get("exec")).toBe(1);
    expect(dispatchedModel(qa.config, "qa")).toBeUndefined();
  });

  it("the rung index increments by exactly one per trigger — rungs are never skipped", () => {
    const config = configWith({ modelLadder: LADDER });
    const state = createLadderState();
    const models: Array<string | undefined> = [];

    for (const _ of [1, 2, 3]) {
      const out = withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state);
      models.push(dispatchedModel(out.config, "qa"));
    }

    expect(models).toEqual(["opus", "fable", "fable"]);
  });

  it("resolveNextRung steps exactly one and clamps at the last entry", () => {
    expect(resolveNextRung(LADDER, 0)).toBe(1);
    expect(resolveNextRung(LADDER, 1)).toBe(2);
    expect(resolveNextRung(LADDER, 2)).toBe(2);
  });

  it("at the top rung a further trigger leaves the model unchanged and sets topOfLadder", () => {
    const config = configWith({ modelLadder: LADDER });
    const state = createLadderState();

    withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state); // → opus
    withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state); // → fable (top)
    const overflow = withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state);

    expect(dispatchedModel(overflow.config, "qa")).toBe("fable");
    expect(overflow.record).toBeUndefined(); // nothing advanced
    expect(overflow.topOfLadder).toBe(true);
    expect(state.topOfLadder.has("qa")).toBe(true);
    expect(state.rungByPhase.get("qa")).toBe(LADDER.length - 1);
  });

  it("canEscalateFurther reports the remaining headroom the dispatch sites gate on", () => {
    const config = configWith({ modelLadder: LADDER });
    const state: LadderState = createLadderState();

    expect(canEscalateFurther(config, "qa", state)).toBe(true);
    state.rungByPhase.set("qa", LADDER.length - 1);
    expect(canEscalateFurther(config, "qa", state)).toBe(false);
    expect(canEscalateFurther(configWith({}), "qa", state)).toBe(false);
  });

  it("a single-rung ladder can never escalate — there is nowhere to go", () => {
    const config = configWith({ modelLadder: ["sonnet"] });
    const state = createLadderState();
    const out = withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state);

    expect(out.record).toBeUndefined();
    expect(out.topOfLadder).toBe(true);
    expect(dispatchedModel(out.config, "qa")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("971 AC-7: a --models pin sets the starting rung; a pin with no ladder never escalates", () => {
  it("a pin that IS a ladder entry starts the phase at that rung", () => {
    const config = configWith({
      modelLadder: LADDER,
      phasePolicies: { qa: { model: "opus" } },
    });
    expect(startingRungFor("qa", config)).toBe(1);

    const state = createLadderState();
    const out = withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state);

    // Escalates from the PIN, not from ladder[0] — the pin is the base.
    expect(dispatchedModel(out.config, "qa")).toBe("fable");
    expect(out.record).toMatchObject({
      rung: 2,
      base: "opus",
      escalated: "fable",
    });
  });

  it("a pin at the TOP rung has nowhere to escalate to", () => {
    const config = configWith({
      modelLadder: LADDER,
      phasePolicies: { qa: { model: "fable" } },
    });
    const out = withEscalatedModel(
      config,
      "qa",
      "LOOP_NO_DIFF",
      createLadderState(),
    );
    expect(out.record).toBeUndefined();
    expect(out.topOfLadder).toBe(true);
    expect(dispatchedModel(out.config, "qa")).toBe("fable"); // pin intact
  });

  it("an OFF-ladder pin never escalates — the pin is never silently downgraded (OQ-3)", () => {
    const config = configWith({
      modelLadder: LADDER,
      phasePolicies: { qa: { model: "haiku" } },
    });
    expect(startingRungFor("qa", config)).toBeNull();

    const state = createLadderState();
    const out = withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state);

    expect(out.config).toBe(config); // by reference — nothing touched
    expect(dispatchedModel(out.config, "qa")).toBe("haiku");
    expect(out.record).toBeUndefined();
    // Critically: NOT ladder[0] ("sonnet"), which would be a downgrade.
    expect(dispatchedModel(out.config, "qa")).not.toBe(LADDER[0]);
    expect(state.rungByPhase.size).toBe(0);
  });

  it("a pin with NO ladder configured never escalates", () => {
    const config = resolve({ models: "qa=opus" });
    expect(startingRungFor("qa", config)).toBeNull();

    const out = withEscalatedModel(
      config,
      "qa",
      "LOOP_NO_DIFF",
      createLadderState(),
    );
    expect(out.config).toBe(config);
    expect(dispatchedModel(out.config, "qa")).toBe("opus");
  });

  it("an unpinned phase starts at rung 0 when a ladder is configured", () => {
    expect(startingRungFor("qa", configWith({ modelLadder: LADDER }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("971 AC-8: the marker-integrity guard suppresses escalation", () => {
  it("a MISSING marker on the marker path produces no trigger, with a reason", () => {
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      lastMarker: null,
      currentSha: "sha-1",
      isDirty: false,
      markerPhase: "qa",
    });
    expect(decision.trigger).toBeNull();
    expect(decision.reason).toMatch(/marker missing/);
  });

  it("a marker with no commitSHA is inconsistent — no trigger", () => {
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      lastMarker: marker({ commitSHA: undefined }),
      currentSha: "sha-1",
      isDirty: false,
      markerPhase: "qa",
    });
    expect(decision.trigger).toBeNull();
    expect(decision.reason).toMatch(/no commitSHA/);
  });

  it("a marker belonging to a different phase is inconsistent — no trigger", () => {
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      lastMarker: marker({ phase: "exec" }),
      currentSha: "sha-1",
      markerPhase: "qa",
    });
    expect(decision.trigger).toBeNull();
    expect(decision.reason).toMatch(/belongs to phase 'exec'/);
  });

  it("a marker with an unparseable timestamp is inconsistent — no trigger", () => {
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      lastMarker: marker({ timestamp: "not-a-date" }),
      currentSha: "sha-1",
      markerPhase: "qa",
    });
    expect(decision.trigger).toBeNull();
    expect(decision.reason).toMatch(/timestamp is unparseable/);
  });

  it("the guard runs BEFORE the signals: a rigged marker suppresses a LOOP_NO_DIFF that would otherwise fire", () => {
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      // This alone would produce LOOP_NO_DIFF (see AC-2).
      loopProgress: {
        progressed: false,
        reason: "LOOP_NO_DIFF",
        message: "no diff",
      },
      lastMarker: null,
      markerPhase: "qa",
    });
    expect(decision.trigger).toBeNull();
    expect(decision.reason).toMatch(/marker missing/);
  });

  it("a rigged marker means the dispatch runs at the unescalated model", () => {
    const config = configWith({ modelLadder: LADDER });
    const { trigger } = detectCapabilityBoundTrigger({
      isRetry: true,
      lastMarker: marker({ commitSHA: undefined }),
      currentSha: "sha-1",
      markerPhase: "qa",
    });
    const out = withEscalatedModel(config, "qa", trigger, createLadderState());
    expect(out.config).toBe(config);
    expect(dispatchedModel(out.config, "qa")).toBeUndefined();
  });

  it("the snapshot-only path needs no marker — its absence does not block LOOP_NO_DIFF", () => {
    // The `run` path detects LOOP_NO_DIFF from a snapshot pair and consults no
    // marker at all; the guard must not fire on a path that never asked for one.
    const decision = detectCapabilityBoundTrigger({
      isRetry: true,
      loopProgress: {
        progressed: false,
        reason: "LOOP_NO_DIFF",
        message: "no diff",
      },
    });
    expect(decision.trigger).toBe("LOOP_NO_DIFF");
  });

  it("checkMarkerIntegrity accepts an intact marker", () => {
    expect(checkMarkerIntegrity(marker(), "qa")).toEqual({
      ok: true,
      reason: "phase marker is intact",
    });
  });
});

// ---------------------------------------------------------------------------

describe("971 AC-10: the recording half", () => {
  it("the escalation facts carry rung, base, escalated and trigger", () => {
    const config = configWith({ modelLadder: LADDER });
    const { config: dispatch } = withEscalatedModel(
      config,
      "exec",
      "LOOP_NO_DIFF",
      createLadderState(),
    );
    expect(dispatch.modelEscalation).toEqual({
      rung: 1,
      base: "sonnet",
      escalated: "opus",
      trigger: "LOOP_NO_DIFF",
    });
  });

  it("includes requestedModel when the rung came from a role: entry (#975 trail note)", () => {
    const config = configWith({
      modelLadder: ["sonnet", "opus"],
      modelLadderRequested: ["role:fast", "role:strong"],
    });
    const { config: dispatch } = withEscalatedModel(
      config,
      "qa",
      "LOOP_NO_DIFF",
      createLadderState(),
    );
    expect(dispatch.modelEscalation?.requestedModel).toBe("role:strong");
  });

  it("marks topOfLadder once the dispatch lands on the last rung", () => {
    const config = configWith({ modelLadder: ["sonnet", "opus"] });
    const { config: dispatch } = withEscalatedModel(
      config,
      "qa",
      "LOOP_NO_DIFF",
      createLadderState(),
    );
    expect(dispatch.modelEscalation?.topOfLadder).toBe(true);
  });

  it("buildEscalationMarkerFields emits FLAT scalars only — nested objects break the marker regex", () => {
    const fields = buildEscalationMarkerFields({
      rung: 1,
      base: "sonnet",
      escalated: "opus",
      trigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: true,
    });

    expect(fields).toEqual({
      ladderRung: 1,
      baseModel: "sonnet",
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: true,
    });
    // The load-bearing property: no value is an object or array, so the
    // serialized marker body contains no nested brace for `[^}]+` to stop at.
    for (const value of Object.values(fields)) {
      expect(typeof value).not.toBe("object");
    }
    expect(JSON.stringify(fields)).not.toMatch(/[:,]\s*[[{]/);
  });

  it("omits the optional fields rather than emitting them empty", () => {
    const fields = buildEscalationMarkerFields({
      rung: 1,
      base: "sonnet",
      escalated: "opus",
      trigger: "LOOP_NO_DIFF",
    });
    expect("requestedModel" in fields).toBe(false);
    expect("topOfLadder" in fields).toBe(false);
  });

  it("a sticky (non-advancing) dispatch still carries facts, labelled STICKY", () => {
    const config = configWith({ modelLadder: LADDER });
    const state = createLadderState();
    withEscalatedModel(config, "qa", "LOOP_NO_DIFF", state);

    const sticky = withEscalatedModel(config, "qa", null, state);
    expect(sticky.config.modelEscalation).toMatchObject({
      rung: 1,
      escalated: "opus",
      trigger: "STICKY",
    });
  });

  it("a non-escalated dispatch sets no modelEscalation key at all", () => {
    const config = configWith({ modelLadder: LADDER });
    const out = withEscalatedModel(config, "qa", null, createLadderState());
    expect("modelEscalation" in out.config).toBe(false);
  });
});

describe("971 AC-10: the ready-gate path surfaces its escalations to the caller", () => {
  it("ReadyResult.modelEscalations carries every rung the gate spent", async () => {
    // The gate's phase results are consumed inside the gate and never reach
    // `IssueResult.phaseResults`, so no `phaseUsage` row is ever built for
    // them. This array is therefore the ONLY channel by which a gate-path
    // escalation becomes auditable — `run-orchestrator.ts` merges it into
    // `MetricRun.modelEscalations` and `commands/ready.ts` prints it.
    const opts: RunReadyGateOptions = {
      issueNumber: 971,
      worktreePath: "/tmp/worktree-971",
      policy: "ac",
      maxIterations: 3,
      config: configWith({ modelLadder: LADDER }),
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      snapshotFn: () => ({ sha: "sha-frozen", dirty: [] }),
      runPhase: (phase) =>
        Promise.resolve({
          phase,
          success: true,
          verdict: phase === "qa" ? "AC_NOT_MET" : undefined,
        } as PhaseResult),
    };

    const result = await runReadyGate(opts);

    // Every entry carries the full fact set the metrics record needs — not
    // just a model name, which would not say which rung or why.
    for (const e of result.modelEscalations) {
      expect(e).toMatchObject({
        phase: expect.any(String),
        rung: expect.any(Number),
        base: expect.any(String),
        escalated: expect.any(String),
        trigger: expect.any(String),
      });
    }
    expect(
      result.modelEscalations.map((e) => `${e.phase}:${e.rung}:${e.escalated}`),
    ).toEqual(["qa:1:opus", "loop:1:opus", "qa:2:fable"]);
  });

  it("stays empty when no ladder is configured, so the metrics field is omitted", () => {
    const config = configWith({});
    const out = withEscalatedModel(
      config,
      "qa",
      "LOOP_NO_DIFF",
      createLadderState(),
    );
    expect(out.record).toBeUndefined();
  });
});
