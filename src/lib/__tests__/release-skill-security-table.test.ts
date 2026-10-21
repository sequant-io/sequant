/**
 * Gate test: the /release skill carries the SECURITY.md supported-versions
 * step (#980 QA rot finding). Runs Step 4.67's own verify fence (#1512) in a
 * temp dir seeded with a `package.json` and a `SECURITY.md`, so the check that
 * a release names its new minor in the table is exercised, not just named.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  skillEnv,
  skillFence,
} from "../../../__tests__/helpers/skill-fence.js";

const WARNING = "does not list 2.21.x";

/** SECURITY.md with the supported-versions table naming `minor`. */
function securityMd(minor: string): string {
  return [
    "## Supported versions",
    "",
    "| Version | Supported |",
    "|---------|-----------|",
    `| ${minor}.x | ✅ |`,
    `| < ${minor} | ❌ |`,
    "",
  ].join("\n");
}

function runVerify(security: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "sequant-security-table-"));
  try {
    writeFileSync(join(dir, "package.json"), '{"version":"2.21.0"}');
    if (security !== null) writeFileSync(join(dir, "SECURITY.md"), security);
    const fence = skillFence("release", {
      section: "### Step 4.67",
      contains: "SECURITY.md",
    });
    const result = spawnSync("bash", ["-c", fence], {
      cwd: dir,
      encoding: "utf-8",
      env: skillEnv(),
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("release Step 4.67 verify fence", () => {
  it("warns when the supported row still names the previous minor", () => {
    expect(runVerify(securityMd("2.20"))).toContain(WARNING);
  });

  it("is silent when the supported row names the minor being released", () => {
    expect(runVerify(securityMd("2.21"))).not.toContain(WARNING);
  });

  it("is silent in a project with no SECURITY.md", () => {
    expect(runVerify(null)).toBe("");
  });
});
