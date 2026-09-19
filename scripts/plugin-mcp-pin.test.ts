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
    readFileSync(
      join(PROJECT_ROOT, ".claude-plugin", "marketplace.json"),
      "utf8",
    ),
  ) as { plugins: Array<{ name: string; source: string }> };

  it("resolves the shipped .mcp.json from marketplace.json `source` and finds the exact pin", () => {
    const entry = marketplace.plugins.find((p) => p.name === "sequant");
    expect(
      entry,
      "marketplace.json must list the sequant plugin",
    ).toBeDefined();

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
    expect(
      script.match(/shippedMcpJsonPath\(\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("#1084 AC-2: shipped .mcp.json launches an inline node -e launcher, no placeholders", () => {
  const shipped = JSON.parse(
    readFileSync(join(PROJECT_ROOT, ".mcp.json"), "utf8"),
  ) as {
    mcpServers?: {
      sequant?: {
        command?: string;
        args?: unknown[];
        env?: Record<string, string>;
      };
    };
  };
  const sequant = shipped.mcpServers?.sequant;

  it("invokes node -e with the inline launcher source, not a file path", () => {
    expect(
      sequant,
      "shipped .mcp.json must declare mcpServers.sequant",
    ).toBeDefined();
    expect(sequant!.command).toBe("node");
    expect(sequant!.args?.[0]).toBe("-e");
    expect(typeof sequant!.args?.[1]).toBe("string");
  });

  it(
    "carries no ${...} anywhere in command, args, or env: Claude Code's " +
      "plugin substituter mis-resolves ${CLAUDE_PLUGIN_ROOT:-x} (see the " +
      "#1084 QA probe) and its generic env expander runs over every arg, " +
      "so even a JS template literal inside the inline launcher source " +
      "would be rewritten or fail config parsing — mcp-launch.mjs uses " +
      "string concatenation for that reason",
    () => {
      expect(sequant!.command).not.toContain("${");
      for (const arg of sequant!.args ?? []) {
        expect(typeof arg === "string" ? arg : "").not.toContain("${");
      }
      expect(sequant!.env).toBeUndefined();
    },
  );

  it("the inline launcher source (args[1]) is byte-identical to the generated form of scripts/mcp-launch.mjs", async () => {
    const { generateInlineLauncherSource } =
      await import("./generate-mcp-launch-inline.mjs");
    expect(sequant!.args?.[1]).toBe(generateInlineLauncherSource());
  });

  it("still carries the concrete sequant@<version> pin as the launcher's argument", () => {
    const pin = readSequantPin(shipped);
    const pkg = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { version: string };
    expect(pin).toBe(`sequant@${pkg.version}`);
    // The inline launcher reads the spec from process.argv[1], which for
    // `node -e <source> <spec>` is args[2] — pin the position, not just the
    // presence, so a reordering cannot pass this test and break the launch.
    expect(sequant!.args?.[2]).toBe(`sequant@${pkg.version}`);
    expect(sequant!.args).toHaveLength(3);
  });

  it(
    "mcp-launch.mjs's own comments never spell out a literal sequant@<version> " +
      "example (prepare-marketplace.ts stamps .mcp.json's args with a global " +
      "sequant@\\S+ replace on release; a literal example version in the " +
      "source would drift from that stamp on the next release and break the " +
      "byte-identical check above)",
    () => {
      const launcherSource = readFileSync(
        join(PROJECT_ROOT, "scripts", "mcp-launch.mjs"),
        "utf8",
      );
      expect(launcherSource.match(/sequant@\d/)).toBeNull();
    },
  );
});
