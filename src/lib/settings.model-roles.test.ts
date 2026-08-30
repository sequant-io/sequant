/**
 * Tests for #975 AC-6: agents.model accepts a free string (not a closed enum).
 *
 * Also verifies the ModelRolesSchema and DEFAULT_MODEL_ROLES structure.
 */

import { describe, it, expect } from "vitest";
import {
  AgentSettingsSchema,
  ModelRolesSchema,
  DEFAULT_MODEL_ROLES,
  RunSettingsSchema,
} from "./settings.js";

describe("#975 AC-6: agents.model accepts a free string", () => {
  it("accepts the legacy haiku/sonnet/opus values", () => {
    expect(() => AgentSettingsSchema.parse({ model: "haiku" })).not.toThrow();
    expect(() => AgentSettingsSchema.parse({ model: "sonnet" })).not.toThrow();
    expect(() => AgentSettingsSchema.parse({ model: "opus" })).not.toThrow();
  });

  it("accepts a dated model ID (e.g. claude-fable-5-20270101)", () => {
    const result = AgentSettingsSchema.parse({
      model: "claude-fable-5-20270101",
    });
    expect(result.model).toBe("claude-fable-5-20270101");
  });

  it("accepts current family aliases (fable, sonnet-5, etc.)", () => {
    expect(AgentSettingsSchema.parse({ model: "fable" }).model).toBe("fable");
    expect(AgentSettingsSchema.parse({ model: "claude-sonnet-5" }).model).toBe(
      "claude-sonnet-5",
    );
  });

  it("defaults to haiku when model is absent", () => {
    expect(AgentSettingsSchema.parse({}).model).toBe("haiku");
  });
});

describe("#975 AC-1: run.modelRoles schema", () => {
  it("DEFAULT_MODEL_ROLES has the expected shipped roles", () => {
    expect(DEFAULT_MODEL_ROLES.fast).toBe("sonnet");
    expect(DEFAULT_MODEL_ROLES.strong).toBe("opus");
    expect(DEFAULT_MODEL_ROLES.frontier).toBe("fable");
  });

  it("ModelRolesSchema parses string shorthand values", () => {
    const result = ModelRolesSchema.parse({ fast: "sonnet", strong: "opus" });
    expect(result.fast).toBe("sonnet");
  });

  it("ModelRolesSchema parses object-map values (cross-driver form)", () => {
    const result = ModelRolesSchema.parse({
      smart: { "claude-code": "sonnet", aider: "gpt-4o" },
    });
    expect((result.smart as Record<string, string>)["claude-code"]).toBe(
      "sonnet",
    );
  });

  it("RunSettingsSchema includes modelRoles with default", () => {
    const result = RunSettingsSchema.parse({});
    expect(result.modelRoles).toEqual(DEFAULT_MODEL_ROLES);
  });

  it("RunSettingsSchema accepts a custom modelRoles map", () => {
    const result = RunSettingsSchema.parse({
      modelRoles: { cheap: "haiku", balanced: "sonnet" },
    });
    expect(result.modelRoles.cheap).toBe("haiku");
    expect(result.modelRoles.balanced).toBe("sonnet");
  });
});
