/**
 * Drift guard for the interactive relay hook (#645).
 *
 * PR #638 added `templates/hooks/relay-check.sh` + the SEQUANT_RELAY sourcing
 * block in `templates/hooks/post-tool.sh`, but never updated the active hooks
 * in `.claude/hooks/`. Every worktree of this repo inherited the stale checked-in
 * post-tool.sh, so the PostToolUse hook chain never sourced relay-check.sh and
 * relay messages were silently consumed without reply.
 *
 * These assertions fail immediately if either of those files drifts again.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const TEMPLATE_RELAY_CHECK = "templates/hooks/relay-check.sh";
const ACTIVE_RELAY_CHECK = ".claude/hooks/relay-check.sh";
const ACTIVE_POST_TOOL = ".claude/hooks/post-tool.sh";

describe("relay hook sync (#645)", () => {
  it("active relay-check.sh is byte-identical to the template", () => {
    const templatePath = path.join(process.cwd(), TEMPLATE_RELAY_CHECK);
    const activePath = path.join(process.cwd(), ACTIVE_RELAY_CHECK);

    expect(fs.existsSync(templatePath)).toBe(true);
    expect(fs.existsSync(activePath)).toBe(true);

    const templateBytes = fs.readFileSync(templatePath);
    const activeBytes = fs.readFileSync(activePath);

    expect(activeBytes.equals(templateBytes)).toBe(true);
  });

  it("active post-tool.sh sources relay-check.sh under SEQUANT_RELAY", () => {
    const activePath = path.join(process.cwd(), ACTIVE_POST_TOOL);
    expect(fs.existsSync(activePath)).toBe(true);

    const content = fs.readFileSync(activePath, "utf-8");

    expect(content).toMatch(/SEQUANT_RELAY:-/);
    expect(content).toMatch(/source\s+"?\$\{?_RELAY_CHECK\}?"?/);
  });
});
