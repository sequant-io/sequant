import { describe, it, expect } from "vitest";
import {
  resolvePhaseAgent,
  resolvePhaseAgents,
  resolveRunAgent,
} from "./phase-agent.js";

describe("#1150: resolvePhaseAgent precedence", () => {
  it("a phase's own agent beats the run-level agent", () => {
    const config = {
      agent: "codex",
      phasePolicies: { qa: { agent: "claude-code" } },
    };
    expect(resolvePhaseAgent(config, "qa")).toBe("claude-code");
    expect(resolvePhaseAgent(config, "exec")).toBe("codex");
  });

  it("falls back to claude-code when nothing names an agent", () => {
    expect(resolvePhaseAgent({}, "exec")).toBe("claude-code");
    expect(resolveRunAgent({})).toBe("claude-code");
  });

  it("a phase policy without an agent does not override the run-level one", () => {
    const config = { agent: "aider", phasePolicies: { exec: { model: "x" } } };
    expect(resolvePhaseAgent(config, "exec")).toBe("aider");
  });

  it("resolveRunAgent ignores phase overrides", () => {
    const config = {
      agent: "codex",
      phasePolicies: { "": { agent: "aider" } },
    };
    expect(resolveRunAgent(config)).toBe("codex");
  });

  it("resolvePhaseAgents lists each distinct driver once, run-level first", () => {
    const config = {
      agent: "codex",
      phasePolicies: {
        qa: { agent: "claude-code" },
        loop: { agent: "claude-code" },
      },
    };
    expect(resolvePhaseAgents(config, ["exec", "qa", "loop"])).toEqual([
      "codex",
      "claude-code",
    ]);
  });
});
