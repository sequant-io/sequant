// #988 AC-5: the documented contract and the CLI hook agree that the skills
// pre-flight is warn-only. Scoped to the exact regions that carry the claim —
// the signal/action table row in docs/internal/plugin-updates.md and the body
// of the commander `preAction` hook in bin/cli.ts — so a stray mention
// elsewhere in either file cannot satisfy the gate (#830 lesson).
//
// Mutation-verified: (a) changing the table row's Action cell back to
// "Auto-sync (copy)" fails the docs assertion; (b) reinstating
// `await syncCommand({ quiet: true })` inside the hook fails the cli gate.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

function versionMismatchRow(): string {
  const doc = fs.readFileSync(
    path.join(ROOT, "docs", "internal", "plugin-updates.md"),
    "utf8",
  );
  const headerIdx = doc.indexOf("| Signal | Detection | Action |");
  expect(headerIdx, "signal/action table header must exist").toBeGreaterThan(-1);
  const rest = doc.slice(headerIdx);
  const table = rest.slice(0, rest.indexOf("\n\n"));
  const row = table
    .split("\n")
    .find((line) => line.startsWith("| **Version mismatch**"));
  expect(row, "Version mismatch row must exist in the table").toBeDefined();
  return row!;
}

function preActionHookBody(): string {
  const cli = fs.readFileSync(path.join(ROOT, "bin", "cli.ts"), "utf8");
  const start = cli.indexOf('program.hook("preAction"');
  expect(start, "preAction hook must exist").toBeGreaterThan(-1);
  const end = cli.indexOf("\n});", start);
  return cli.slice(start, end);
}

describe("#988 AC-5: warn-only contract is documented and enforced", () => {
  it("docs table: the version-mismatch action is warn-only, not auto-sync (copy)", () => {
    const row = versionMismatchRow();
    expect(row).toMatch(/warn/i);
    expect(row).not.toMatch(/Auto-sync \(copy\)/);
    expect(row).not.toContain("syncCommand(");
  });

  it("bin/cli.ts preAction hook delegates to runVersionPreflight and never calls syncCommand", () => {
    const body = preActionHookBody();
    expect(body).toContain("runVersionPreflight(");
    expect(body).not.toContain("syncCommand(");
    expect(body).not.toContain("copyTemplates(");
  });

  it("the exempt list documented for the hook includes serve", async () => {
    const { PREFLIGHT_EXEMPT_COMMANDS } = await import("./version-preflight.js");
    expect([...PREFLIGHT_EXEMPT_COMMANDS].sort()).toEqual(["init", "serve", "sync", "update"]);
    const doc = fs.readFileSync(path.join(ROOT, "docs", "internal", "plugin-updates.md"), "utf8");
    const skipIdx = doc.indexOf("The `preAction` hook is **skipped entirely**");
    expect(skipIdx).toBeGreaterThan(-1);
    const para = doc.slice(skipIdx, doc.indexOf("\n\n", skipIdx));
    expect(para).toContain("`serve`");
  });
});
