/**
 * Tests for the PhaseRegistry class and the built-in phase registrations.
 *
 * The registry is the single source of truth for workflow phase definitions
 * (replaces PHASE_PROMPTS / AIDER_PHASE_PROMPTS / ISOLATED_PHASES /
 * UI_LABELS / SECURITY_LABELS scattered across the workflow modules).
 */

import { describe, it, expect } from "vitest";
import {
  PhaseRegistry,
  phaseRegistry,
  getPhaseNames,
  type PhaseDefinition,
} from "./phase-registry.js";

describe("PhaseRegistry class (AC-2)", () => {
  it("register / get round-trips a definition", () => {
    const reg = new PhaseRegistry();
    const def: PhaseDefinition = {
      name: "deploy",
      skill: "deploy",
      promptTemplate: "Deploy issue #{issue}",
      requiresWorktree: true,
    };

    reg.register(def);

    expect(reg.get("deploy")).toEqual(def);
    expect(reg.has("deploy")).toBe(true);
    expect(reg.list()).toEqual([def]);
    expect(reg.names()).toEqual(["deploy"]);
  });

  it("has() is false before registration, true after", () => {
    const reg = new PhaseRegistry();
    expect(reg.has("nope")).toBe(false);
    reg.register({
      name: "nope",
      skill: "nope",
      promptTemplate: "x",
      requiresWorktree: false,
    });
    expect(reg.has("nope")).toBe(true);
  });

  it("duplicate register throws (fail-fast on misconfigured bootstrap)", () => {
    const reg = new PhaseRegistry();
    const def: PhaseDefinition = {
      name: "spec",
      skill: "spec",
      promptTemplate: "x",
      requiresWorktree: false,
    };
    reg.register(def);
    expect(() => reg.register(def)).toThrowError(/already registered/);
  });

  it("get() on unknown name throws with available list", () => {
    const reg = new PhaseRegistry();
    reg.register({
      name: "spec",
      skill: "spec",
      promptTemplate: "x",
      requiresWorktree: false,
    });
    reg.register({
      name: "exec",
      skill: "exec",
      promptTemplate: "x",
      requiresWorktree: true,
    });
    expect(() => reg.get("nope")).toThrowError(/unknown phase "nope"/);
    expect(() => reg.get("nope")).toThrowError(/Available: spec, exec/);
  });

  it("list() preserves insertion order", () => {
    const reg = new PhaseRegistry();
    const phases = ["a", "b", "c"];
    for (const name of phases) {
      reg.register({
        name,
        skill: name,
        promptTemplate: "x",
        requiresWorktree: false,
      });
    }
    expect(reg.list().map((p) => p.name)).toEqual(phases);
    expect(reg.names()).toEqual(phases);
  });
});

describe("Built-in phase registrations (AC-3)", () => {
  it("registers all 9 canonical phases in pipeline order", () => {
    // Insertion order in phase-registry.ts IS the canonical pipeline order
    // — preserved verbatim from the pre-registry PhaseSchema typed-enum.
    expect(phaseRegistry.names()).toEqual([
      "spec",
      "security-review",
      "exec",
      "testgen",
      "test",
      "verify",
      "qa",
      "loop",
      "merger",
    ]);
  });

  it("every phase has all required PhaseDefinition fields populated", () => {
    // AC-3 contract: no special-casing — every phase has the same shape.
    for (const def of phaseRegistry.list()) {
      expect(typeof def.name).toBe("string");
      expect(typeof def.skill).toBe("string");
      expect(typeof def.promptTemplate).toBe("string");
      expect(typeof def.requiresWorktree).toBe("boolean");
      expect(def.promptTemplate).toContain("{issue}");
    }
  });

  it("requiresWorktree matches the pre-registry ISOLATED_PHASES set", () => {
    // Pre-registry constant: ["exec", "security-review", "testgen", "test", "qa", "loop"]
    const isolated = phaseRegistry
      .list()
      .filter((p) => p.requiresWorktree)
      .map((p) => p.name)
      .sort();
    expect(isolated).toEqual(
      ["exec", "security-review", "testgen", "test", "qa", "loop"].sort(),
    );
  });

  it("non-worktree phases match the pre-registry set (spec, verify, merger)", () => {
    const mainRepo = phaseRegistry
      .list()
      .filter((p) => !p.requiresWorktree)
      .map((p) => p.name)
      .sort();
    expect(mainRepo).toEqual(["spec", "verify", "merger"].sort());
  });

  it("aider driverOverrides are registered for all 9 phases (AC-8 — no parallel map)", () => {
    // Pre-registry: AIDER_PHASE_PROMPTS had 9 entries. After migration the
    // same data lives in PhaseDefinition.driverOverrides.aider.
    for (const def of phaseRegistry.list()) {
      const aiderOverride = def.driverOverrides?.aider;
      expect(aiderOverride).toBeDefined();
      expect(typeof aiderOverride?.promptTemplate).toBe("string");
      expect(aiderOverride?.promptTemplate).toContain("{issue}");
    }
  });

  it("test phase carries UI detect labels (replaces UI_LABELS constant)", () => {
    const test = phaseRegistry.get("test");
    expect(test.detect?.labels).toEqual([
      "ui",
      "frontend",
      "admin",
      "web",
      "browser",
    ]);
  });

  it("security-review phase carries security detect labels (replaces SECURITY_LABELS)", () => {
    const sec = phaseRegistry.get("security-review");
    expect(sec.detect?.labels).toEqual([
      "security",
      "auth",
      "authentication",
      "permissions",
      "admin",
    ]);
  });

  it("loop phase has retryStrategy.maxRetries=0 (encodes 'skip cold-start retries')", () => {
    const loop = phaseRegistry.get("loop");
    expect(loop.retryStrategy?.maxRetries).toBe(0);
  });

  it("spec phase has retryStrategy.extraRetries=1 (encodes SPEC_EXTRA_RETRIES)", () => {
    const spec = phaseRegistry.get("spec");
    expect(spec.retryStrategy?.extraRetries).toBe(1);
    expect(spec.retryStrategy?.backoffMs).toBe(5000);
  });
});

describe("getPhaseNames() (AC-3, AC-5)", () => {
  it("returns the same array as phaseRegistry.names()", () => {
    expect(getPhaseNames()).toEqual(phaseRegistry.names());
  });

  it("returned array is in canonical pipeline order", () => {
    const names = getPhaseNames();
    expect(names[0]).toBe("spec");
    expect(names[names.length - 1]).toBe("merger");
  });
});
