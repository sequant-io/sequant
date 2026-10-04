/**
 * Drift guard for hooks (#645, #1265).
 *
 * PR #638 added relay support to `templates/hooks/` but never updated the
 * active hooks in `.claude/hooks/`. The installed `post-tool.sh` was
 * Mar-25-era and missed the SEQUANT_RELAY sourcing block, so the
 * PostToolUse chain never advanced the relay cursor. After the reconcile
 * in PR #649, every file present in `templates/hooks/` MUST be byte-identical
 * to its `.claude/hooks/` counterpart — there is no allowed divergence.
 *
 * `.claude/hooks/` MAY contain extra files that templates don't have. As of
 * #986 there are none: `capture-tokens.sh`, previously the one intentionally
 * local hook, was promoted into `templates/hooks/` so consumer projects and
 * plugin users get the token-usage fallback too.
 *
 * #1265 added `plugin/hooks/` as a second mirror (the slim plugin folder
 * `marketplace.json` now ships) and holds it to the same byte-identity bar.
 *
 * `plugin/hooks/hooks.json` is the one file there with no templates/ source:
 * it is the hand-maintained registration manifest. #1271 retired the root
 * `hooks/` copy it used to be synced from, so the guard on it is structural:
 * every script it registers must exist in `plugin/hooks/`.
 *
 * Run `npm run sync-hooks` (scripts/sync-hooks.sh) to regenerate
 * `.claude/hooks/` and `plugin/hooks/` from the templates after editing any
 * template hook.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const TEMPLATES_DIR = "templates/hooks";
const ACTIVE_DIR = ".claude/hooks";
const PLUGIN_DIR = "plugin/hooks";

function listHookFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => fs.statSync(path.join(dir, n)).isFile())
    .sort();
}

/**
 * Script file names a plugin hooks.json registers, from commands of the form
 * `"${CLAUDE_PLUGIN_ROOT}/hooks/<name>"`. A command in any other form is
 * returned whole, so it reads as missing rather than being skipped.
 */
function registeredHookScripts(
  events: Record<string, Array<{ hooks: Array<{ command: string }> }>>,
): string[] {
  const prefix = "${CLAUDE_PLUGIN_ROOT}/hooks/";
  const names = new Set<string>();
  for (const groups of Object.values(events)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const command = hook.command.replace(/^"|"$/g, "");
        names.add(
          command.startsWith(prefix) ? command.slice(prefix.length) : command,
        );
      }
    }
  }
  return [...names].sort();
}

describe("hook sync (#645)", () => {
  const templatesPath = path.join(process.cwd(), TEMPLATES_DIR);
  const activePath = path.join(process.cwd(), ACTIVE_DIR);

  it("every file in templates/hooks/ exists byte-identically in .claude/hooks/", () => {
    expect(fs.existsSync(templatesPath)).toBe(true);
    expect(fs.existsSync(activePath)).toBe(true);

    const templateFiles = listHookFiles(templatesPath);
    expect(templateFiles.length).toBeGreaterThan(0);

    const drift: string[] = [];
    for (const name of templateFiles) {
      const tBytes = fs.readFileSync(path.join(templatesPath, name));
      const aPath = path.join(activePath, name);
      if (!fs.existsSync(aPath)) {
        drift.push(`MISSING: .claude/hooks/${name}`);
        continue;
      }
      const aBytes = fs.readFileSync(aPath);
      if (!aBytes.equals(tBytes)) {
        drift.push(`DRIFT: .claude/hooks/${name}`);
      }
    }

    expect(drift).toEqual([]);
  });

  it("every file in templates/hooks/ exists byte-identically in plugin/hooks/", () => {
    const pluginPath = path.join(process.cwd(), PLUGIN_DIR);
    expect(fs.existsSync(pluginPath)).toBe(true);

    const templateFiles = listHookFiles(templatesPath);
    const drift: string[] = [];
    for (const name of templateFiles) {
      const tBytes = fs.readFileSync(path.join(templatesPath, name));
      const pPath = path.join(pluginPath, name);
      if (!fs.existsSync(pPath)) {
        drift.push(`MISSING: plugin/hooks/${name}`);
        continue;
      }
      const pBytes = fs.readFileSync(pPath);
      if (!pBytes.equals(tBytes)) {
        drift.push(`DRIFT: plugin/hooks/${name}`);
      }
    }

    expect(drift).toEqual([]);
  });

  it("every script plugin/hooks/hooks.json registers exists in plugin/hooks/ (#1271)", () => {
    const pluginPath = path.join(process.cwd(), PLUGIN_DIR);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginPath, "hooks.json"), "utf-8"),
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const registered = registeredHookScripts(manifest.hooks);
    expect(registered.length).toBeGreaterThan(0);

    const missing = registered.filter(
      (name) => !fs.existsSync(path.join(pluginPath, name)),
    );
    expect(missing).toEqual([]);
  });

  it(".claude/hooks/ may have extra local-only files (e.g. capture-tokens.sh)", () => {
    // This is documentation-as-test: we intentionally allow `.claude/hooks/`
    // to contain files that aren't in templates. If we ever decide that's
    // wrong, flip this test to enforce parity in both directions.
    const templateFiles = new Set(listHookFiles(templatesPath));
    const activeFiles = listHookFiles(activePath);
    const extras = activeFiles.filter((n) => !templateFiles.has(n));
    // Just assert the contract; don't fail on extras.
    expect(extras.every((n) => typeof n === "string")).toBe(true);
  });

  it("post-tool.sh sources relay-check.sh under SEQUANT_RELAY (kept for clarity)", () => {
    // Redundant with the byte-equality check above, but kept so a failure
    // here points directly at the relay regression rather than a generic
    // "files differ" message.
    const content = fs.readFileSync(
      path.join(activePath, "post-tool.sh"),
      "utf-8",
    );
    expect(content).toMatch(/SEQUANT_RELAY:-/);
    expect(content).toMatch(/source\s+"?\$\{?_RELAY_CHECK\}?"?/);
  });
});
