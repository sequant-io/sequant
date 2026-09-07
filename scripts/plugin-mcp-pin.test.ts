// #988 AC-4: the .mcp.json that plugin users actually install is pinned.
// `marketplace.json` declares the plugin `source` ("./" today), so the shipped
// MCP config is whatever `.mcp.json` sits at that path — the repo root — not
// the copy prepare-marketplace stamps under dist/. #793 pinned only the dist
// copy, which the GitHub marketplace never installs, and users kept getting
// `sequant@latest` (the trigger for the #988 incident).
//
// Mutation-verified: setting the root .mcp.json arg back to `sequant@latest`
// fails the pin assertion.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(__dirname, "..");

function readSequantPin(mcpJson: unknown): string | undefined {
  const config = mcpJson as Record<string, unknown>;
  const servers =
    (config.mcpServers as Record<string, unknown> | undefined) ?? config;
  const sequant = servers?.sequant as { args?: unknown } | undefined;
  return Array.isArray(sequant?.args)
    ? (sequant!.args.find(
        (a: unknown) => typeof a === "string" && a.startsWith("sequant@"),
      ) as string | undefined)
    : undefined;
}

describe("#988 AC-4: shipped plugin .mcp.json is pinned to the package version", () => {
  const pkg = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as { version: string };
  const marketplace = JSON.parse(
    readFileSync(join(PROJECT_ROOT, ".claude-plugin", "marketplace.json"), "utf8"),
  ) as { plugins: Array<{ name: string; source: string }> };

  it("resolves the shipped .mcp.json from marketplace.json `source` and finds the exact pin", () => {
    const entry = marketplace.plugins.find((p) => p.name === "sequant");
    expect(entry, "marketplace.json must list the sequant plugin").toBeDefined();

    const shipped = join(PROJECT_ROOT, entry!.source, ".mcp.json");
    const pin = readSequantPin(JSON.parse(readFileSync(shipped, "utf8")));

    expect(pin).toBe(`sequant@${pkg.version}`);
    expect(pin).not.toBe("sequant@latest");
  });

  it("prepare-marketplace stamps and validates that same file, not only the dist copy", () => {
    const script = readFileSync(
      join(PROJECT_ROOT, "scripts", "prepare-marketplace.ts"),
      "utf8",
    );
    // Both halves must reference the marketplace-resolved path helper.
    expect(script).toContain("function shippedMcpJsonPath()");
    expect(script.match(/shippedMcpJsonPath\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
