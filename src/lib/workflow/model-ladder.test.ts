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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #995: the three ladder halts live in the RUN path's quality loop, so the
// AC-named tests below drive `runIssueWithLogging` for real with only the
// driver boundary mocked — the same seam `batch-executor.model-ladder.test.ts`
// uses. `importOriginal` is spread so every other export of `phase-executor.js`
// stays real; the collaborator mocks below are the modules the loop reaches
// for that need a filesystem/network. None of this affects the ready-gate
// tests in this file, which inject `runPhase` and never reach these modules.
vi.mock("./phase-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
  hasExecChanges: vi.fn().mockReturnValue(true),
}));
vi.mock("./worktree-manager.js", () => ({
  createCheckpointCommit: vi.fn(),
  rebaseBeforePR: vi.fn(),
  createPR: vi.fn(),
  readCacheMetrics: vi.fn(),
  filterResumedPhases: vi.fn(),
}));
vi.mock("./log-writer.js", () => ({
  LogWriter: vi.fn(),
  createPhaseLogFromTiming: vi.fn(),
}));
vi.mock("./state-manager.js", () => ({ StateManager: vi.fn() }));
vi.mock("./git-diff-utils.js", () => ({
  getGitDiffStats: vi.fn(),
  getCommitHash: vi.fn(),
  resolveDiffBase: vi.fn(),
}));

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
  formatEscalationTriggerLabel,
  type LadderState,
} from "./model-ladder.js";
import { parsePhaseMarkers } from "./phase-detection.js";
import { withEscalatedEffort } from "./effort-escalation.js";
import {
  buildExecutionConfig,
  resolveRunOptions,
  resolveModelLadder,
} from "./config-resolver.js";
import { runReadyGate, type RunReadyGateOptions } from "./ready-gate.js";
import { executePhaseWithRetry } from "./phase-executor.js";
import { runIssueWithLogging } from "./batch-executor.js";
import type { IssueExecutionContext } from "./types.js";
import type { LoopProgressSnapshot } from "./qa-stagnation.js";
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
    //
    // 4 iterations, not 3: retry 1 belongs to #915's effort rung (AC-5), so
    // the first model rung lands on retry 2 and a SECOND rung needs one more
    // pass. Budgeting for it keeps this test covering both the `loop` phase's
    // record and a second rung, rather than stopping after the first.
    const dispatched: Array<{ phase: string; model?: string }> = [];
    const opts: RunReadyGateOptions = {
      issueNumber: 971,
      worktreePath: "/tmp/worktree-971",
      policy: "ac",
      maxIterations: 4,
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
    // Passes 1 and 2 run at the unescalated base — pass 2 is retry 1, which
    // spends #915's effort rung rather than a model rung (AC-5). Passes 3 and
    // 4 are retries 2 and 3, one model rung up each.
    expect(qaModels).toEqual([undefined, undefined, "opus", "fable"]);
    // qa→opus, loop→opus (iteration 3), qa→fable (iteration 4). Iteration 4's
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

    // #995 supersedes #971's expectation here, by design rather than by
    // accident. Under #971 this ran its full 3-iteration budget and stopped at
    // MAX_ITERATIONS; #995 AC-3 adds the halt, so the SECOND consecutive
    // divergence-suspect pass now terminates the gate with an evidence bundle.
    // MAX_ITERATIONS would have sent the human to raise a cap that was never
    // the constraint.
    //
    // What this AC actually asserts — that advancing SHAs never buy a rung —
    // is unchanged and still checked below.
    expect(result.iterations).toBe(2);
    expect(result.reason).toBe("DIVERGENCE_SUSPECT");
    // Every dispatch, qa and loop alike, ran on the unescalated model.
    expect(dispatched.every((d) => d.model === undefined)).toBe(true);
    expect(result.modelEscalations).toEqual([]);
    expect(result.haltBundle).toContain("(empty — no model rung was spent)");
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
      // 4 iterations for the same reason as the AC-2 gate test above: retry 1
      // is #915's effort rung (AC-5), so two model rungs need four passes.
      maxIterations: 4,
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

// ---------------------------------------------------------------------------
// #995 — the halts (#971 part B).
//
// The three cases where the ladder must STOP and hand off to a human rather
// than climb. Driven through the real quality loop in `runIssueWithLogging`
// with only the driver boundary mocked, so the assertions are on what the loop
// actually did — how many dispatches it issued, which models it sent, and the
// evidence bundle it printed — rather than on a hand-fed halt.
// ---------------------------------------------------------------------------

const mockExecutePhase = vi.mocked(executePhaseWithRetry);

/** A run-path context whose progress snapshot the test controls. */
function haltCtx(
  config: Partial<ExecutionConfig>,
  snapshotProgressFn: (cwd: string) => LoopProgressSnapshot,
  maxIterations = 5,
): IssueExecutionContext {
  return {
    issueNumber: 995,
    title: "ladder halts",
    labels: [],
    config: {
      phases: ["exec"],
      phaseTimeout: 1800,
      qualityLoop: true,
      maxIterations,
      sequential: false,
      concurrency: 3,
      parallel: false,
      verbose: false,
      noSmartTests: false,
      dryRun: false,
      mcp: false,
      retry: false,
      ...config,
    } as ExecutionConfig,
    options: { autoDetectPhases: false } as RunOptions,
    services: { logWriter: null, stateManager: null },
    worktree: { path: "/tmp/worktree-995", branch: "feature/995" },
    snapshotProgressFn,
  } as IssueExecutionContext;
}

/** Models the loop dispatched `exec` with, in order. */
function haltDispatchedModels(): Array<string | undefined> {
  return mockExecutePhase.mock.calls
    .filter((c) => c[1] === "exec")
    .map((c) => (c[2] as ExecutionConfig).phasePolicies?.exec?.model);
}

let consoleSpy: ReturnType<typeof vi.spyOn>;
/** Everything the loop printed, joined — the halt's human-facing surface. */
function printed(): string {
  return consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  // The real quality loop calls `emitProgressLine`, which writes the
  // launcher's `SEQUANT_PROGRESS:` wire protocol to stderr whenever
  // `SEQUANT_ORCHESTRATOR` is set — true when this suite runs inside an
  // orchestrated `sequant run`. Leaking synthetic lines for issue 995 would
  // spoof progress for whatever run is actually in flight.
  vi.stubEnv("SEQUANT_ORCHESTRATOR", "");
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mockExecutePhase.mockResolvedValue({
    phase: "exec",
    success: false,
    durationSeconds: 1,
    error: "not converged",
    verdict: "AC_NOT_MET",
  } as PhaseResult);
});

afterEach(() => {
  consoleSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("971 AC-3 halt: divergence-suspect stops the loop with an evidence bundle", () => {
  it("halts after two consecutive iterations that each produced a new SHA at a failing verdict", async () => {
    // An ADVANCING snapshot is the divergence-suspect fingerprint: work landed
    // every iteration and the verdict never moved. Two in a row is the pattern
    // #971 AC-3 names.
    let n = 0;
    await runIssueWithLogging(
      haltCtx({ modelLadder: LADDER }, () => ({
        sha: `sha-${n++}`,
        dirty: [],
      })),
    );

    // The budget was 5 iterations; the halt cut it to 2. Asserting the
    // DISPATCH COUNT (not just the final status) is what proves the loop
    // stopped rather than merely reported.
    expect(haltDispatchedModels()).toHaveLength(2);
    // AC-3's load-bearing half: the model option never changed.
    expect(haltDispatchedModels().every((m) => m === undefined)).toBe(true);

    const out = printed();
    expect(out).toContain("Ladder halt: DIVERGENCE_SUSPECT");
    // The bundle's three required contents: SHAs tried, verdicts, and an
    // EMPTY escalation history. Matched by shape rather than by literal SHA:
    // the loop snapshots twice per iteration (open and close), so the exact
    // counter values are an artifact of the harness, whereas "two distinct
    // SHAs were recorded" is the fact AC-3 asks for.
    expect(out).toMatch(/SHAs tried: sha-\d+, sha-\d+/);
    expect(out.match(/verdict=AC_NOT_MET/g)).toHaveLength(2);
    expect(out).toContain("(empty — no model rung was spent)");
  });

  it("does NOT halt on a single divergence-suspect iteration — that is the ordinary quality loop", async () => {
    // The regression guard for the halt's own threshold. Iteration 1 diverges
    // (HEAD advances), every later iteration produces nothing — which is
    // capability-bound and breaks the streak. If the halt fired on the first
    // divergence-suspect iteration, every ordinary `AC_NOT_MET → /loop → re-QA`
    // cycle in the product would become a dead run.
    const shas = ["sha-a", "sha-b"];
    let i = 0;
    await runIssueWithLogging(
      haltCtx({ modelLadder: LADDER }, () => ({
        sha: shas[Math.min(i++, shas.length - 1)],
        dirty: [],
      })),
    );

    expect(printed()).not.toContain("Ladder halt: DIVERGENCE_SUSPECT");
    // 4 dispatches, not 2: the divergence halt never fired. The run still
    // stops one short of its 5-iteration budget, but on the OTHER halt — five
    // consecutive no-diff iterations exhaust this 3-rung ladder, so iteration
    // 5 presents a trigger at the top rung (AC-9). Asserting the reason, not
    // just the count, keeps the two halts from covering for each other.
    expect(haltDispatchedModels()).toEqual([
      undefined,
      undefined,
      "opus",
      "fable",
    ]);
    expect(printed()).toContain("Ladder halt: TOP_OF_LADDER");
  });

  it("AC-D1: with NO ladder configured the divergence halt is unreachable", async () => {
    let n = 0;
    await runIssueWithLogging(
      haltCtx({}, () => ({ sha: `sha-${n++}`, dirty: [] })),
    );
    expect(printed()).not.toContain("Ladder halt");
    expect(haltDispatchedModels()).toHaveLength(5);
  });
});

describe("971 AC-4: a SPEC_DIVERGENCE marker halts without escalating", () => {
  it("halts on the first dispatch, spends no rung, and names the AC the agent declared impossible", async () => {
    mockExecutePhase.mockResolvedValue({
      phase: "exec",
      success: false,
      durationSeconds: 1,
      error: "spec is self-contradictory",
      specDivergence: {
        acs: "AC-2",
        message: "AC-2 requires the file to both exist and not exist",
      },
    } as PhaseResult);

    let n = 0;
    await runIssueWithLogging(
      haltCtx({ modelLadder: LADDER }, () => ({
        sha: `sha-${n++}`,
        dirty: [],
      })),
    );

    // "No retry is dispatched, no rung is spent, the run halts": one dispatch
    // out of a 5-iteration budget, at the base (unset) model.
    expect(haltDispatchedModels()).toEqual([undefined]);

    const out = printed();
    expect(out).toContain("Ladder halt: SPEC_DIVERGENCE");
    expect(out).toContain("Declared impossible: AC-2");
    expect(out).toContain("AC-2 requires the file to both exist and not exist");
    expect(out).toContain("(empty — no model rung was spent)");
  });

  it("halts even when the phase itself reported success — the declaration is the signal, not the exit status", async () => {
    mockExecutePhase.mockResolvedValue({
      phase: "exec",
      success: true,
      durationSeconds: 1,
      specDivergence: { acs: "AC-7" },
    } as PhaseResult);

    await runIssueWithLogging(
      haltCtx({ modelLadder: LADDER }, () => ({ sha: "sha-x", dirty: [] })),
    );

    expect(haltDispatchedModels()).toEqual([undefined]);
    expect(printed()).toContain("Ladder halt: SPEC_DIVERGENCE");
  });

  it("reports the missing AC explicitly when the agent declared divergence without naming one", async () => {
    mockExecutePhase.mockResolvedValue({
      phase: "exec",
      success: false,
      durationSeconds: 1,
      specDivergence: {},
    } as PhaseResult);

    await runIssueWithLogging(
      haltCtx({ modelLadder: LADDER }, () => ({ sha: "sha-x", dirty: [] })),
    );

    // AC-14 requires the halt output to NAME the AC, so a divergence with no
    // AC is a reportable fact rather than a silently omitted line.
    expect(printed()).toContain("Declared impossible: (the agent named no AC)");
  });

  it("halts with NO ladder configured too — the escape hatch is not a ladder feature", async () => {
    mockExecutePhase.mockResolvedValue({
      phase: "exec",
      success: false,
      durationSeconds: 1,
      specDivergence: { acs: "AC-1" },
    } as PhaseResult);

    await runIssueWithLogging(haltCtx({}, () => ({ sha: "sha-x", dirty: [] })));

    // Unlike the two ladder halts, this one is reachable without a ladder: a
    // contradictory spec is not a model-capability question at all.
    expect(haltDispatchedModels()).toEqual([undefined]);
    expect(printed()).toContain("Ladder halt: SPEC_DIVERGENCE");
  });

  it("ready-gate path: a QA pass that declares divergence terminates the gate as SPEC_DIVERGENCE", async () => {
    let qaCalls = 0;
    const opts: RunReadyGateOptions = {
      issueNumber: 995,
      worktreePath: "/tmp/worktree-995",
      policy: "ac",
      maxIterations: 4,
      config: configWith({ modelLadder: LADDER }),
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      snapshotFn: () => ({ sha: "sha-frozen", dirty: [] }),
      runPhase: (phase) => {
        if (phase === "qa") qaCalls++;
        return Promise.resolve({
          phase,
          success: true,
          verdict: phase === "qa" ? "AC_NOT_MET" : undefined,
          ...(phase === "qa" ? { specDivergence: { acs: "AC-4" } } : {}),
        } as PhaseResult);
      },
    };

    const result = await runReadyGate(opts);

    expect(result.reason).toBe("SPEC_DIVERGENCE");
    expect(result.ready).toBe(false);
    expect(result.issueStatus).toBe("blocked");
    // One QA pass out of a 4-iteration budget: the gate stopped, it did not
    // merely relabel its terminal reason.
    expect(qaCalls).toBe(1);
    expect(result.modelEscalations).toEqual([]);
    expect(result.haltBundle).toContain("Declared impossible: AC-4");
    // The bundle reaches the human-facing report, not just the struct.
    expect(result.report).toContain("Ladder halt evidence");
    expect(result.report).toContain("SPEC_DIVERGENCE");
  });

  it("the exec and loop skills tell agents when to emit the marker, in all three mirrored copies", async () => {
    const { readFileSync } = await import("fs");
    for (const skill of ["exec", "loop"]) {
      const copies = [
        `templates/skills/${skill}/SKILL.md`,
        `.claude/skills/${skill}/SKILL.md`,
        `skills/${skill}/SKILL.md`,
      ].map((f) => readFileSync(f, "utf8"));

      // Scoped to the section the AC is about, not the whole file: matching
      // anywhere would let an unrelated mention of the marker satisfy the gate.
      for (const body of copies) {
        const section = body.slice(
          body.indexOf("When the spec is impossible as written"),
        );
        expect(section).not.toBe("");
        expect(section).toContain("SPEC_DIVERGENCE");
        expect(section).toContain('"outcome":"SPEC_DIVERGENCE"');
      }
      // All three mirrors byte-identical (I-4).
      expect(new Set(copies).size).toBe(1);
    }
  });
});

describe("971 AC-9: a further trigger at the top rung halts instead of looping", () => {
  it("halts with a NON-empty escalation history ending at the last rung", async () => {
    // A two-rung ladder reaches the top in one escalation, so the FOURTH
    // iteration is the first that can present a trigger with nowhere to go.
    await runIssueWithLogging(
      haltCtx({ modelLadder: ["sonnet", "opus"] }, () => ({
        sha: "frozen",
        dirty: [],
      })),
    );

    // Iterations 1-2 at the base rung (retry 1 belongs to #915's effort rung),
    // iteration 3 one rung up, then the halt — instead of a fourth dispatch
    // that would re-run the model that already failed.
    expect(haltDispatchedModels()).toEqual([undefined, undefined, "opus"]);

    const out = printed();
    expect(out).toContain("Ladder halt: TOP_OF_LADDER");
    expect(out).not.toContain("(empty — no model rung was spent)");
    expect(out).toContain("exec: sonnet → opus");
  });

  it("AC-D1: with NO ladder configured the top-of-ladder halt is unreachable", async () => {
    await runIssueWithLogging(
      haltCtx({}, () => ({ sha: "frozen", dirty: [] })),
    );
    expect(printed()).not.toContain("Ladder halt");
    expect(haltDispatchedModels()).toHaveLength(5);
  });
});

describe("971 AC-10 verbose: the escalated dispatch names the trigger in words", () => {
  it("prints `model: sonnet → opus (no-progress retry)` on a LOOP_NO_DIFF escalation", async () => {
    await runIssueWithLogging(
      haltCtx({ modelLadder: ["sonnet", "opus"], verbose: true }, () => ({
        sha: "frozen",
        dirty: [],
      })),
    );

    // The AC pins this line verbatim. Asserted against what the loop actually
    // printed — not against a string the test rebuilt from the same helper.
    expect(printed()).toContain("model: sonnet → opus (no-progress retry)");
    // The raw reason code must not survive anywhere in the output.
    expect(printed()).not.toContain("(LOOP_NO_DIFF retry)");
  });

  it("maps every trigger code to a phrase, and passes an unknown code through unchanged", () => {
    expect(formatEscalationTriggerLabel("LOOP_NO_DIFF")).toBe("no-progress");
    expect(formatEscalationTriggerLabel("SAME_SHA_NO_PROGRESS")).toBe(
      "no-progress",
    );
    expect(formatEscalationTriggerLabel("STICKY")).toBe("sticky");
    // An honest passthrough beats `undefined` when a trigger is added later.
    expect(formatEscalationTriggerLabel("FUTURE_CODE")).toBe("FUTURE_CODE");
  });
});

describe("971 AC-D2: the marker schema append is backward-compatible", () => {
  it("a pre-#995 phase marker still parses", () => {
    const parsed = parsePhaseMarkers(
      '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2026-01-01T00:00:00.000Z"} -->',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].outcome).toBeUndefined();
    expect(parsed[0].divergenceAcs).toBeUndefined();
  });

  it("round-trips a SPEC_DIVERGENCE marker through the flat-scalar parser", () => {
    const parsed = parsePhaseMarkers(
      '<!-- SEQUANT_PHASE: {"phase":"exec","status":"failed","timestamp":"2026-01-01T00:00:00.000Z","outcome":"SPEC_DIVERGENCE","divergenceAcs":"AC-2, AC-5"} -->',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].outcome).toBe("SPEC_DIVERGENCE");
    expect(parsed[0].divergenceAcs).toBe("AC-2, AC-5");
  });

  it("rejects an unrecognized outcome rather than halting a run on a typo", () => {
    // A closed enum, deliberately: `SPEC_DIVERGANCE` must not silently parse
    // into a field the halt sites read.
    expect(
      parsePhaseMarkers(
        '<!-- SEQUANT_PHASE: {"phase":"exec","status":"failed","timestamp":"2026-01-01T00:00:00.000Z","outcome":"SPEC_DIVERGANCE"} -->',
      ),
    ).toHaveLength(0);
  });
});
