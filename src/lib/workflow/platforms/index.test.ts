import { describe, it, expect } from "vitest";
import { getPlatform } from "./index.js";

describe("platform registry", () => {
  it("returns GitHubProvider for 'github'", () => {
    const provider = getPlatform("github");
    expect(provider.name).toBe("github");
  });

  it("defaults to 'github' when no name provided", () => {
    const provider = getPlatform();
    expect(provider.name).toBe("github");
  });

  it("throws on unknown platform name", () => {
    expect(() => getPlatform("unknown-platform")).toThrow(
      /Unknown platform provider "unknown-platform"/,
    );
  });

  it("error message lists available providers", () => {
    expect(() => getPlatform("nonexistent")).toThrow(/github/);
  });
});
