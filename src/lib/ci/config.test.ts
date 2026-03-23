import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadCIConfig, resolveConfig } from "./config.js";
import { CI_DEFAULTS } from "./types.js";
import { readFileSync } from "node:fs";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);

describe("loadCIConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty config when no files exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config).toEqual({});
  });

  it("loads .github/sequant.yml", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("sequant.yml")) {
        return "agent: aider\ntimeout: 900\nphases: exec,qa";
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.agent).toBe("aider");
    expect(config.timeout).toBe(900);
    expect(config.phases).toEqual(["exec", "qa"]);
  });

  it("loads .sequant/ci.json as fallback", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("ci.json")) {
        return JSON.stringify({
          agent: "codex",
          timeout: 600,
          qualityLoop: true,
        });
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.agent).toBe("codex");
    expect(config.timeout).toBe(600);
    expect(config.qualityLoop).toBe(true);
  });

  it("prefers .github/sequant.yml over .sequant/ci.json", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("sequant.yml")) {
        return "agent: aider";
      }
      if (String(path).includes("ci.json")) {
        return JSON.stringify({ agent: "codex" });
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.agent).toBe("aider");
  });

  it("ignores YAML comments and blank lines", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("sequant.yml")) {
        return "# This is a comment\n\nagent: aider\n# Another comment\ntimeout: 300\n";
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.agent).toBe("aider");
    expect(config.timeout).toBe(300);
  });

  it("rejects invalid agent names", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("sequant.yml")) {
        return "agent: invalid-agent";
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.agent).toBeUndefined();
  });

  it("rejects timeout below 60", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("sequant.yml")) {
        return "timeout: 30";
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.timeout).toBeUndefined();
  });

  it("parses maxConcurrentRuns from JSON", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("ci.json")) {
        return JSON.stringify({ maxConcurrentRuns: 3 });
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.maxConcurrentRuns).toBe(3);
  });

  it("handles JSON array phases", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("ci.json")) {
        return JSON.stringify({ phases: ["exec", "qa"] });
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.phases).toEqual(["exec", "qa"]);
  });

  it("handles malformed JSON gracefully", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("sequant.yml")) {
        throw new Error("ENOENT");
      }
      if (String(path).includes("ci.json")) {
        return "not valid json{{{";
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config).toEqual({});
  });

  it("parses boolean qualityLoop from YAML string", () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("sequant.yml")) {
        return "qualityLoop: true";
      }
      throw new Error("ENOENT");
    });

    const config = loadCIConfig("/repo");
    expect(config.qualityLoop).toBe(true);
  });
});

describe("resolveConfig", () => {
  it("fills in all defaults for empty config", () => {
    const resolved = resolveConfig({});
    expect(resolved).toEqual(CI_DEFAULTS);
  });

  it("overrides defaults with provided values", () => {
    const resolved = resolveConfig({ agent: "aider", timeout: 900 });
    expect(resolved.agent).toBe("aider");
    expect(resolved.timeout).toBe(900);
    expect(resolved.phases).toEqual(CI_DEFAULTS.phases);
  });
});
