import { describe, it, expect } from "vitest";
import { parseInputs, validateInputs } from "./inputs.js";
import type { CIConfig } from "./types.js";

describe("parseInputs", () => {
  it("parses all inputs from raw strings", () => {
    const result = parseInputs({
      issues: "42 99",
      phases: "spec,exec",
      agent: "claude-code",
      timeout: "3600",
      "quality-loop": "true",
      "api-key": "sk-test-key",
    });

    expect(result.issues).toEqual([42, 99]);
    expect(result.phases).toEqual(["spec", "exec"]);
    expect(result.agent).toBe("claude-code");
    expect(result.timeout).toBe(3600);
    expect(result.qualityLoop).toBe(true);
    expect(result.apiKey).toBe("sk-test-key");
  });

  it("applies defaults when inputs are empty", () => {
    const result = parseInputs({ issues: "1", "api-key": "key" });

    expect(result.phases).toEqual(["spec", "exec", "qa"]);
    expect(result.agent).toBe("claude-code");
    expect(result.timeout).toBe(1800);
    expect(result.qualityLoop).toBe(false);
  });

  it("merges config file defaults when inputs are empty", () => {
    const config: CIConfig = {
      agent: "aider",
      phases: ["exec", "qa"],
      timeout: 900,
    };
    const result = parseInputs({ issues: "1", "api-key": "key" }, config);

    expect(result.agent).toBe("aider");
    expect(result.phases).toEqual(["exec", "qa"]);
    expect(result.timeout).toBe(900);
  });

  it("workflow inputs override config file", () => {
    const config: CIConfig = { agent: "aider", timeout: 900 };
    const result = parseInputs(
      { issues: "1", agent: "claude-code", timeout: "1800", "api-key": "key" },
      config,
    );

    expect(result.agent).toBe("claude-code");
    expect(result.timeout).toBe(1800);
  });

  it("parses comma-separated issue numbers", () => {
    const result = parseInputs({ issues: "1,2,3", "api-key": "key" });
    expect(result.issues).toEqual([1, 2, 3]);
  });

  it("ignores invalid issue numbers", () => {
    const result = parseInputs({ issues: "42 abc -1 99", "api-key": "key" });
    expect(result.issues).toEqual([42, 99]);
  });

  it("falls back to default agent for unknown agents", () => {
    const result = parseInputs({
      issues: "1",
      agent: "unknown-agent",
      "api-key": "key",
    });
    expect(result.agent).toBe("claude-code");
  });

  it("falls back to default phases for all-invalid phases", () => {
    const result = parseInputs({
      issues: "1",
      phases: "bogus,fake",
      "api-key": "key",
    });
    expect(result.phases).toEqual(["spec", "exec", "qa"]);
  });

  it("filters invalid phases from mixed input", () => {
    const result = parseInputs({
      issues: "1",
      phases: "spec,bogus,qa",
      "api-key": "key",
    });
    expect(result.phases).toEqual(["spec", "qa"]);
  });

  it("handles empty api-key", () => {
    const result = parseInputs({ issues: "1" });
    expect(result.apiKey).toBe("");
  });
});

describe("validateInputs", () => {
  const validInputs = {
    issues: [42],
    phases: ["spec" as const, "exec" as const, "qa" as const],
    agent: "claude-code",
    timeout: 1800,
    qualityLoop: false,
    apiKey: "sk-test",
  };

  it("returns no errors for valid inputs", () => {
    expect(validateInputs(validInputs)).toEqual([]);
  });

  it("reports missing issues", () => {
    const errors = validateInputs({ ...validInputs, issues: [] });
    expect(errors).toContain("No valid issue numbers provided");
  });

  it("reports missing phases", () => {
    const errors = validateInputs({ ...validInputs, phases: [] });
    expect(errors).toContain("No valid phases provided");
  });

  it("reports missing API key", () => {
    const errors = validateInputs({ ...validInputs, apiKey: "" });
    expect(errors).toContainEqual(
      expect.stringContaining("API key is required"),
    );
  });

  it("reports timeout too low", () => {
    const errors = validateInputs({ ...validInputs, timeout: 30 });
    expect(errors).toContain("Timeout must be at least 60 seconds");
  });

  it("reports timeout too high", () => {
    const errors = validateInputs({ ...validInputs, timeout: 10000 });
    expect(errors).toContain("Timeout must not exceed 7200 seconds (2 hours)");
  });

  it("collects multiple errors", () => {
    const errors = validateInputs({
      issues: [],
      phases: [],
      agent: "claude-code",
      timeout: 10,
      qualityLoop: false,
      apiKey: "",
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});
