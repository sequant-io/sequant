/**
 * Gate tests for the merge-queue payload and trigger (#1350).
 *
 * The ci.yml assertions are scoped to the `on:` block and to top-level job
 * keys, so a comment elsewhere in the file cannot satisfy them (CLAUDE.md
 * §Testing). The ruleset assertions run the real script and parse its output.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts", "ruleset-main.sh");

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

function printRules(): Rule[] {
  const out = execFileSync("bash", [SCRIPT, "--print"], { encoding: "utf8" });
  return (JSON.parse(out) as { rules: Rule[] }).rules;
}

function ciOnBlock(): string {
  const lines = readFileSync(
    join(ROOT, ".github/workflows/ci.yml"),
    "utf8",
  ).split("\n");
  const start = lines.findIndex((l) => l === "on:");
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines.slice(start, end).join("\n");
}

describe("ci.yml merge_group trigger (AC-1)", () => {
  it("declares merge_group as a key of the on: block", () => {
    const keys = ciOnBlock()
      .split("\n")
      .filter((l) => /^ {2}[a-z_]+:/.test(l))
      .map((l) => l.trim().replace(/:.*$/, ""));
    expect(keys).toContain("merge_group");
  });

  it("keeps the test and canary jobs, with no matrix", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/^ {2}test:$/m);
    expect(ci).toMatch(/^ {2}canary:$/m);
    expect(ci).not.toMatch(/^\s+matrix:/m);
  });
});

describe("ruleset-main.sh --print merge queue (AC-2, AC-2b)", () => {
  it("emits a merge_queue rule and no strict up-to-date flag", () => {
    const rules = printRules();
    expect(rules.map((r) => r.type)).toContain("merge_queue");
    const checks = rules.find((r) => r.type === "required_status_checks");
    expect(checks?.parameters?.strict_required_status_checks_policy).not.toBe(
      true,
    );
  });

  it("requires test and canary", () => {
    const checks = printRules().find(
      (r) => r.type === "required_status_checks",
    );
    const contexts = (
      checks?.parameters?.required_status_checks as { context: string }[]
    ).map((c) => c.context);
    expect(contexts).toEqual(["test", "canary"]);
  });

  it("merges by squash", () => {
    const queue = printRules().find((r) => r.type === "merge_queue");
    expect(queue?.parameters?.merge_method).toBe("SQUASH");
  });

  it("never applies the ruleset (no PUT call in the script)", () => {
    const script = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(() => execFileSync("bash", ["-n", SCRIPT])).not.toThrow();
    expect(script).not.toMatch(/gh api|--method PUT|-X PUT/);
  });
});
