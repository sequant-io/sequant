/**
 * #996 AC-3 — opencode subagent definitions written by `init --agent opencode`.
 *
 * The `grep -c 'mode: subagent'` gate the AC names is a sanity check, not a
 * real gate: opencode's `AgentConfig` has an open index signature, so a
 * misspelled key is silently accepted and inert. These assertions therefore
 * check the translated *values*, and the CI smoke job runs
 * `opencode debug agent <name>` for the resolution proof.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  OPENCODE_AGENT_NAMES,
  translateAgentDefinition,
  writeOpencodeAgents,
  writeOpencodeMcpConfig,
  writeOpencodePlugin,
} from "./init.js";

const REPO_ROOT = resolve(__dirname, "../..");

function frontmatterOf(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  expect(m).not.toBeNull();
  return parseYaml(m![1]) as Record<string, unknown>;
}

describe("996 AC-3: opencode subagent definitions", () => {
  let target: string;
  let prevTemplates: string | undefined;

  beforeAll(async () => {
    prevTemplates = process.env.SEQUANT_TEMPLATES_DIR;
    process.env.SEQUANT_TEMPLATES_DIR = join(REPO_ROOT, "templates");
    target = mkdtempSync(join(tmpdir(), "sequant-init-opencode-"));
    await writeOpencodeAgents(target);
    await writeOpencodePlugin(target);
    await writeOpencodeMcpConfig(target);
  });

  afterAll(() => {
    if (prevTemplates === undefined) delete process.env.SEQUANT_TEMPLATES_DIR;
    else process.env.SEQUANT_TEMPLATES_DIR = prevTemplates;
    rmSync(target, { recursive: true, force: true });
  });

  it("writes exactly the three sequant agent definitions", () => {
    // Three, not four: #927 deleted sequant-explorer (0 spawns across 169
    // /spec runs), so a fourth def would have no Claude-side counterpart.
    expect([...OPENCODE_AGENT_NAMES]).toEqual([
      "sequant-implementer",
      "sequant-qa-checker",
      "sequant-testgen",
    ]);
    for (const name of OPENCODE_AGENT_NAMES) {
      expect(existsSync(join(target, ".opencode/agents", `${name}.md`))).toBe(true);
    }
  });

  it("marks every definition mode: subagent", () => {
    const count = execFileSync(
      "sh",
      ["-c", `grep -c 'mode: subagent' ${join(target, ".opencode/agents")}/*.md | wc -l`],
      { encoding: "utf-8" },
    ).trim();
    expect(Number(count)).toBe(3);

    for (const name of OPENCODE_AGENT_NAMES) {
      const fm = frontmatterOf(
        readFileSync(join(target, ".opencode/agents", `${name}.md`), "utf-8"),
      );
      expect(fm.mode).toBe("subagent");
    }
  });

  it("translates maxTurns into steps", () => {
    // `steps` and `maxSteps` both resolve to `steps` on 1.18.27 — the AC's
    // literal `steps` key is correct and must not be "corrected".
    const cases: Array<[string, number]> = [
      ["sequant-implementer", 25],
      ["sequant-qa-checker", 15],
      ["sequant-testgen", 25],
    ];
    for (const [name, steps] of cases) {
      const fm = frontmatterOf(
        readFileSync(join(target, ".opencode/agents", `${name}.md`), "utf-8"),
      );
      expect(fm.steps).toBe(steps);
    }
  });

  it("translates the Claude tools allowlist into an opencode tools map", () => {
    const fm = frontmatterOf(
      readFileSync(join(target, ".opencode/agents/sequant-qa-checker.md"), "utf-8"),
    );
    // Read/Grep/Glob/Bash → lowercase opencode ids.
    expect(fm.tools).toMatchObject({
      bash: true,
      glob: true,
      grep: true,
      read: true,
    });
  });

  it("denies unlisted mutating tools rather than leaving them unset", () => {
    // opencode derives `permission` from this map, so an omission is an allow.
    const fm = frontmatterOf(
      readFileSync(join(target, ".opencode/agents/sequant-qa-checker.md"), "utf-8"),
    );
    const tools = fm.tools as Record<string, boolean>;
    expect(tools.write).toBe(false);
    expect(tools.edit).toBe(false);
    // patch/apply_patch writes files but carries no path field, so the
    // Edit/Write guard cannot see its targets — it must be denied, never
    // passed through.
    expect(tools.patch).toBe(false);
  });

  it("preserves the definition body verbatim", () => {
    const written = readFileSync(
      join(target, ".opencode/agents/sequant-testgen.md"),
      "utf-8",
    );
    expect(written).toContain(
      "You are a test stub generation agent for the sequant development workflow.",
    );
  });

  it("keeps a def with no tools allowlist unrestricted", () => {
    // sequant-implementer has no `tools` key in Claude Code, meaning "all
    // tools". Emitting a narrower map would silently shrink its capability.
    const written = readFileSync(
      join(target, ".opencode/agents/sequant-implementer.md"),
      "utf-8",
    );
    expect(frontmatterOf(written).tools).toBeUndefined();
  });

  it("throws on a definition with no frontmatter rather than emitting a dead def", () => {
    expect(() => translateAgentDefinition("no frontmatter here")).toThrow(
      /no YAML frontmatter/,
    );
  });

  it("installs the hook shim as an entry plus a core module", () => {
    const entry = join(target, ".opencode/plugin/sequant-hooks.ts");
    const core = join(target, ".opencode/plugin/lib/sequant-hooks-core.ts");
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(core)).toBe(true);

    // The split is load-bearing: opencode scans plugin/*.ts non-recursively
    // and rejects a scanned module that exports a non-function, so the entry
    // may export nothing but the plugin function.
    const entryText = readFileSync(entry, "utf-8");
    // The entry writes the sentinel via the imported constant; the literal
    // itself lives in the core module.
    expect(entryText).toContain("SHIM_LOADED_SENTINEL");
    const exported = [...entryText.matchAll(/^export\s+(?:const|function)\s+(\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(["server"]);

    expect(readFileSync(core, "utf-8")).toContain(
      'SHIM_LOADED_SENTINEL = "SEQUANT_HOOK_SHIM_ACTIVE"',
    );
  });

  it("writes the MCP entry under opencode's flat mcp key", () => {
    const config = JSON.parse(
      readFileSync(join(target, ".opencode/opencode.json"), "utf-8"),
    );
    expect(config.mcp.sequant.type).toBe("local");
    expect(Array.isArray(config.mcp.sequant.command)).toBe(true);
    expect(config).not.toHaveProperty("mcpServers");
  });

  it("preserves an existing opencode.json when merging the MCP entry", async () => {
    const config = JSON.parse(
      readFileSync(join(target, ".opencode/opencode.json"), "utf-8"),
    );
    config.theme = "sequant-custom";
    config.mcp.other = { type: "local", command: ["echo"] };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(target, ".opencode/opencode.json"),
      JSON.stringify(config, null, 2),
    );

    await writeOpencodeMcpConfig(target);

    const merged = JSON.parse(
      readFileSync(join(target, ".opencode/opencode.json"), "utf-8"),
    );
    expect(merged.theme).toBe("sequant-custom");
    expect(merged.mcp.other).toBeDefined();
    expect(merged.mcp.sequant).toBeDefined();
  });
});
