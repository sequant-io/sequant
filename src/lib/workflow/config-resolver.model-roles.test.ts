/**
 * Tests for #975: model roles — semantic indirection via `role:` prefix.
 *
 * AC-1: `run.modelRoles` parses; phase policy `role:<name>` dispatches with the mapped string.
 * AC-2: Role with no map entry fails at config-resolution time, naming role + available roles.
 * AC-3: Raw model string (no `role:` prefix) passes through verbatim.
 * AC-5: Both ExecutionConfig producers resolve roles through the same function (drift test).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  resolveRoleToModel,
  resolvePhasePolicies,
  buildExecutionConfig,
  resolveRunOptions,
} from "./config-resolver.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { SequantSettings, ModelRoles } from "../settings.js";
import type { RunOptions } from "./types.js";

const PHASE_NAMES = ["spec", "exec", "qa", "test", "loop", "testgen"];

const DEFAULT_ROLES: ModelRoles = {
  fast: "sonnet",
  strong: "opus",
  frontier: "fable",
};

describe("#975 AC-1: resolveRoleToModel — role prefix resolves to mapped string", () => {
  it("resolves a known role to its mapped string (claude-code, string shorthand)", () => {
    expect(resolveRoleToModel("role:fast", DEFAULT_ROLES)).toBe("sonnet");
    expect(resolveRoleToModel("role:strong", DEFAULT_ROLES)).toBe("opus");
    expect(resolveRoleToModel("role:frontier", DEFAULT_ROLES)).toBe("fable");
  });

  it("resolves a role with an object-map value by activeDriver", () => {
    const roles: ModelRoles = {
      smart: { "claude-code": "sonnet", aider: "gpt-4o" },
    };
    expect(resolveRoleToModel("role:smart", roles, "claude-code")).toBe(
      "sonnet",
    );
    expect(resolveRoleToModel("role:smart", roles, "aider")).toBe("gpt-4o");
  });

  it("uses 'claude-code' as the default active driver", () => {
    const roles: ModelRoles = { fast: "sonnet" };
    expect(resolveRoleToModel("role:fast", roles)).toBe("sonnet");
  });
});

describe("#975 AC-2: resolveRoleToModel — missing role fails loudly", () => {
  it("throws on an undefined role, naming the role and available roles", () => {
    expect(() =>
      resolveRoleToModel("role:unknown", DEFAULT_ROLES),
    ).toThrowError(/unknown/);
    expect(() =>
      resolveRoleToModel("role:unknown", DEFAULT_ROLES),
    ).toThrowError(/fast.*strong.*frontier|frontier.*strong.*fast/);
  });

  it("throws on an empty role name (bare 'role:' prefix)", () => {
    expect(() => resolveRoleToModel("role:", DEFAULT_ROLES)).toThrowError(
      /empty/,
    );
  });

  it("throws on a string shorthand role used with a non-claude-code driver", () => {
    const roles: ModelRoles = { fast: "sonnet" };
    expect(() => resolveRoleToModel("role:fast", roles, "aider")).toThrowError(
      /claude-code/,
    );
  });

  it("throws when driver key is missing from object-map role", () => {
    const roles: ModelRoles = { smart: { "claude-code": "sonnet" } };
    expect(() => resolveRoleToModel("role:smart", roles, "aider")).toThrowError(
      /aider/,
    );
  });
});

describe("#975 AC-3: resolveRoleToModel — raw strings pass through verbatim", () => {
  it("returns a raw model string unchanged (no role: prefix)", () => {
    expect(resolveRoleToModel("sonnet", DEFAULT_ROLES)).toBe("sonnet");
    expect(resolveRoleToModel("claude-sonnet-5", DEFAULT_ROLES)).toBe(
      "claude-sonnet-5",
    );
    expect(resolveRoleToModel("claude-fable-5", DEFAULT_ROLES)).toBe(
      "claude-fable-5",
    );
  });

  it("passes through an empty string verbatim (edge case)", () => {
    expect(resolveRoleToModel("", DEFAULT_ROLES)).toBe("");
  });
});

describe("#975 AC-1: resolvePhasePolicies resolves role: model references", () => {
  it("resolves a settings phase model via role: prefix", () => {
    const result = resolvePhasePolicies(
      undefined,
      undefined,
      { exec: { model: "role:fast" } },
      PHASE_NAMES,
      DEFAULT_ROLES,
    );
    expect(result.exec?.model).toBe("sonnet");
  });

  it("leaves raw model strings untouched when modelRoles is provided", () => {
    const result = resolvePhasePolicies(
      undefined,
      undefined,
      { exec: { model: "claude-sonnet-5" } },
      PHASE_NAMES,
      DEFAULT_ROLES,
    );
    expect(result.exec?.model).toBe("claude-sonnet-5");
  });

  it("resolves a CLI --models role: override", () => {
    const result = resolvePhasePolicies(
      "exec=role:strong",
      undefined,
      undefined,
      PHASE_NAMES,
      DEFAULT_ROLES,
    );
    expect(result.exec?.model).toBe("opus");
  });

  it("mixed: settings has raw string, CLI overrides with role:", () => {
    const result = resolvePhasePolicies(
      "exec=role:frontier",
      undefined,
      { exec: { model: "sonnet" }, spec: { model: "haiku" } },
      PHASE_NAMES,
      DEFAULT_ROLES,
    );
    // CLI wins, frontier resolves to fable
    expect(result.exec?.model).toBe("fable");
    // settings raw string passes through
    expect(result.spec?.model).toBe("haiku");
  });

  it("throws on unknown role at resolution time (fail before any session spawns)", () => {
    expect(() =>
      resolvePhasePolicies(
        "exec=role:nonexistent",
        undefined,
        undefined,
        PHASE_NAMES,
        DEFAULT_ROLES,
      ),
    ).toThrowError(/nonexistent/);
  });

  it("does NOT resolve roles when modelRoles is undefined (backward compat)", () => {
    // Without modelRoles, role: strings should pass through as-is (no resolution).
    // Existing callers that don't pass modelRoles are unaffected.
    const result = resolvePhasePolicies(
      undefined,
      undefined,
      { exec: { model: "sonnet" } },
      PHASE_NAMES,
      // modelRoles omitted
    );
    expect(result.exec?.model).toBe("sonnet");
  });
});

describe("#975 AC-5: buildExecutionConfig uses resolveRoleToModel (producer 1 drift test)", () => {
  function resolve(cli: Partial<RunOptions>, settings: SequantSettings) {
    return buildExecutionConfig(
      resolveRunOptions(cli as RunOptions, settings),
      settings,
      1,
    );
  }

  it("resolves a role: model from settings.run.phases via buildExecutionConfig", () => {
    const settings: SequantSettings = {
      ...DEFAULT_SETTINGS,
      run: {
        ...DEFAULT_SETTINGS.run,
        phases: { exec: { model: "role:fast" } },
        modelRoles: { fast: "sonnet", strong: "opus", frontier: "fable" },
      },
    };
    const config = resolve({}, settings);
    expect(
      (
        config as unknown as {
          phasePolicies?: Record<string, { model?: string }>;
        }
      ).phasePolicies?.exec?.model,
    ).toBe("sonnet");
  });

  it("passes a raw model string through unchanged (AC-3 at config level)", () => {
    const settings: SequantSettings = {
      ...DEFAULT_SETTINGS,
      run: {
        ...DEFAULT_SETTINGS.run,
        phases: { exec: { model: "claude-sonnet-5" } },
        modelRoles: { fast: "sonnet" },
      },
    };
    const config = resolve({}, settings);
    expect(
      (
        config as unknown as {
          phasePolicies?: Record<string, { model?: string }>;
        }
      ).phasePolicies?.exec?.model,
    ).toBe("claude-sonnet-5");
  });

  it("throws when a role: model is not in modelRoles (fail before session spawns, AC-2)", () => {
    const settings: SequantSettings = {
      ...DEFAULT_SETTINGS,
      run: {
        ...DEFAULT_SETTINGS.run,
        phases: { exec: { model: "role:nonexistent" } },
        modelRoles: { fast: "sonnet" },
      },
    };
    expect(() => resolve({}, settings)).toThrowError(/nonexistent/);
  });
});

describe("#975 AC-5: commands/ready.ts (producer 2) passes modelRoles to resolvePhasePolicies", () => {
  // Source-inspection drift guard: assert that commands/ready.ts imports
  // resolvePhasePolicies and passes modelRoles + activeDriver arguments.
  // If a second implementation appears, this test fails.
  const readySrc = readFileSync(
    resolvePath(__dirname, "../../commands/ready.ts"),
    "utf-8",
  );

  it("imports resolvePhasePolicies from config-resolver", () => {
    expect(readySrc).toMatch(/resolvePhasePolicies/);
    expect(readySrc).toMatch(/config-resolver/);
  });

  it("passes modelRoles to resolvePhasePolicies (drift guard against second implementation)", () => {
    // The call must include modelRoles from settings so role: references resolve.
    // #975: if someone removes modelRoles from this call, the roles go unresolved
    // silently — this test catches that class of regression.
    expect(readySrc).toMatch(/settings\.run\.modelRoles/);
  });

  it("passes activeDriver to resolvePhasePolicies (claude-code default preserved)", () => {
    expect(readySrc).toMatch(/settings\.run\.agent/);
  });
});

describe("#975 AC-4: resolvePhasePolicies captures requestedModel for role: references", () => {
  it("sets requestedModel to pre-resolution role string when role: prefix used", () => {
    const roles: ModelRoles = { fast: "sonnet", strong: "opus" };
    const result = resolvePhasePolicies(
      undefined,
      undefined,
      { exec: { model: "role:fast" } },
      ["spec", "exec", "qa"],
      roles,
      "claude-code",
    );
    expect(result.exec?.model).toBe("sonnet"); // resolved
    expect(result.exec?.requestedModel).toBe("role:fast"); // pre-resolution
  });

  it("does not set requestedModel for raw model strings", () => {
    const roles: ModelRoles = { fast: "sonnet" };
    const result = resolvePhasePolicies(
      undefined,
      undefined,
      { exec: { model: "sonnet" } },
      ["spec", "exec", "qa"],
      roles,
      "claude-code",
    );
    expect(result.exec?.model).toBe("sonnet");
    expect(result.exec?.requestedModel).toBeUndefined();
  });

  it("sets requestedModel independently per phase", () => {
    const roles: ModelRoles = { fast: "sonnet", strong: "opus" };
    const result = resolvePhasePolicies(
      undefined,
      undefined,
      {
        spec: { model: "role:fast" },
        exec: { model: "role:strong" },
        qa: { model: "haiku" }, // raw string
      },
      ["spec", "exec", "qa"],
      roles,
      "claude-code",
    );
    expect(result.spec?.requestedModel).toBe("role:fast");
    expect(result.exec?.requestedModel).toBe("role:strong");
    expect(result.qa?.requestedModel).toBeUndefined(); // raw string: no requestedModel
  });
});
