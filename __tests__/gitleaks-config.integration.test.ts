/**
 * #1352 — the gitleaks config flags the leak classes generic scanners miss,
 * passes the committed tree, and the CI workflow is wired to it.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const ROOT = resolve(__dirname, "..");
const CONFIG = join(ROOT, ".gitleaks.toml");
const HAS_GITLEAKS = spawnSync("gitleaks", ["version"]).status === 0;
if (!HAS_GITLEAKS && process.env.SEQUANT_REQUIRE_GITLEAKS === "1") {
  throw new Error(
    "gitleaks is required (SEQUANT_REQUIRE_GITLEAKS=1) but not installed",
  );
}
const run = HAS_GITLEAKS ? it : it.skip;

function scan(
  dir: string,
  config = CONFIG,
): { status: number | null; rules: string[] } {
  const report = join(dir, "..", `report-${Date.now()}-${Math.random()}.json`);
  const r = spawnSync(
    "gitleaks",
    ["dir", "--config", config, "--no-banner", "-f", "json", "-r", report, dir],
    { encoding: "utf8" },
  );
  let rules: string[] = [];
  try {
    rules = (
      JSON.parse(readFileSync(report, "utf8")) as Array<{ RuleID: string }>
    ).map((x) => x.RuleID);
  } catch {
    /* no report written */
  }
  return { status: r.status, rules };
}

function fixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gitleaks-fixture-"));
  const sub = join(dir, "tree");
  mkdirSync(sub);
  writeFileSync(join(sub, "leak.md"), content);
  return sub;
}

describe("gitleaks project rules (#1352)", () => {
  run("flags a real-shaped home path", () => {
    const sub = fixture("cwd was /Users/bartholomew/Projects/thing\n");
    try {
      expect(scan(sub).rules).toContain("home-path");
    } finally {
      rmSync(dirname(sub), { recursive: true, force: true });
    }
  });

  run("flags a Claude session URL", () => {
    const sub = fixture(
      "see https://claude.ai/code/session_012abcDEF345ghiJKL678mno\n",
    );
    try {
      expect(scan(sub).rules).toContain("claude-session-url");
    } finally {
      rmSync(dirname(sub), { recursive: true, force: true });
    }
  });

  run(
    "flags a /Users/alice/ path but allows the /Users/user/ placeholder",
    () => {
      const sub = fixture("cd /Users/alice/proj\ncd /Users/user/proj\n");
      try {
        expect(scan(sub).rules).toEqual(["home-path"]);
      } finally {
        rmSync(dirname(sub), { recursive: true, force: true });
      }
    },
  );

  run("passes the committed tree", () => {
    const ls = spawnSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const outer = mkdtempSync(join(tmpdir(), "gitleaks-tree-"));
    const tree = join(outer, "tree");
    try {
      for (const f of ls.stdout.split("\0").filter(Boolean)) {
        const dest = join(tree, f);
        mkdirSync(dirname(dest), { recursive: true });
        try {
          copyFileSync(join(ROOT, f), dest);
        } catch {
          /* deleted in the working tree */
        }
      }
      const result = scan(tree);
      expect(result.rules).toEqual([]);
      expect(result.status).toBe(0);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe("gitleaks config content (#1352 AC-4)", () => {
  it("every project rule regex is shape-based, not a literal word", () => {
    const toml = readFileSync(CONFIG, "utf8");
    const regexes = [...toml.matchAll(/^regex = '''(.*)'''$/gm)].map(
      (m) => m[1],
    );
    expect(regexes.length).toBeGreaterThanOrEqual(3);
    for (const re of regexes) expect(re).toMatch(/[\[\\]/);
  });
});

describe("gitleaks workflow shape (#1352 AC-2)", () => {
  const wf = readFileSync(join(ROOT, ".github/workflows/gitleaks.yml"), "utf8");

  it("triggers on pull_request and merge_group", () => {
    const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
    expect(on).toContain("pull_request:");
    expect(on).toContain("merge_group:");
  });

  it("runs gitleaks detect with the project config and verifies the checksum", () => {
    expect(wf).toContain("gitleaks detect --config .gitleaks.toml");
    expect(wf).toContain("sha256sum -c -");
  });

  it("pins every uses: to a commit SHA", () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
