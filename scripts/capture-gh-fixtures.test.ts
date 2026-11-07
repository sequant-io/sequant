import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  CAPTURES,
  assertReadOnly,
  capture,
  redact,
} from "./capture-gh-fixtures.js";
import { loadGhFixture } from "../src/lib/workflow/platforms/gh-fixtures.js";

describe("capture-gh-fixtures (#1506)", () => {
  it.each([
    [["issue", "comment", "1", "--body", "x"]],
    [["pr", "create", "--title", "t"]],
    [["pr", "merge", "7"]],
    [["issue", "edit", "1", "--add-label", "bug"]],
    [["label", "create", "x"]],
    [["api", "-X", "PATCH", "repos/o/r/pulls/7"]],
    [["api", "--method=DELETE", "repos/o/r"]],
    [["api", "graphql", "-f", "query=mutation"]],
    [["api", "repos/o/r/issues", "--input", "-"]],
    // Attached short flags (security review): cobra reads -XPOST as -X POST.
    [["api", "-XPOST", "repos/o/r/issues"]],
    [["api", "repos/o/r/issues", "-ftitle=x"]],
    [["api", "repos/o/r/issues", "-Fbody=@f"]],
    [["api", "repos/o/r", "--field=title=x"]],
    [["api", "graphql", "-q", ".data"]],
    // Writing verbs a deny list missed: the guard is now an allowlist.
    [["run", "rerun", "123"]],
    [["workflow", "run", "ci.yml"]],
    [["secret", "set", "TOKEN"]],
    [["repo", "fork"]],
    [["issue", "close", "1"]],
  ])("refuses the writing call %j", (args) => {
    expect(() => assertReadOnly(args)).toThrow(/refusing to capture/);
  });

  it.each([
    [["issue", "view", "1", "--json", "title"]],
    [["pr", "list", "--state", "open"]],
    [["api", "repos/o/r/commits/abc/check-runs", "-q", ".check_runs"]],
    [["auth", "status"]],
    [["--version"]],
    [["pr", "checks", "7"]],
    [["release", "view", "--repo", "o/r"]],
  ])("allows the read-only call %j", (args) => {
    expect(() => assertReadOnly(args)).not.toThrow();
  });

  it("every capture is read-only and has a captured fixture on disk", () => {
    for (const capture of CAPTURES) {
      expect(() => assertReadOnly(capture.run ?? capture.args)).not.toThrow();
      const fixture = loadGhFixture(capture.name);
      expect(fixture.provenance).toBe("captured");
      expect(fixture.args).toEqual(capture.args);
      expect(fixture.command).toMatch(/^gh /);
    }
  });

  describe("redact (security review)", () => {
    // Built at run time so this file never holds a scan-shaped value itself.
    const session = ["https://claude.ai/code/", "session_", "01AbCdEf"].join(
      "",
    );
    const home = ["/", "Users", "/", "someone", "/repo/x.ts"].join("");
    const email = ["someone", "@", "example", ".org"].join("");

    it.each([
      [`see ${session} for the run`, "https://claude.ai/code/<session-redacted>"],
      [`env ${["cse", "_01AbCdEf"].join("")} ran`, "cse_REDACTED"],
      [`token ${["gh", "o_", "abc123DEF456"].join("")}`, "gho_REDACTED"],
      [`key ${["sk-", "ant-", "api03-xyz"].join("")}`, "sk-ant-REDACTED"],
      [`at ${home}:12`, "/Users/<redacted>/repo/x.ts"],
      [`by ${email}`, "redacted@example.com"],
    ])("replaces a secret-shaped value in %j", (input, expected) => {
      const out = redact(input);
      expect(out).toContain(expected);
      expect(out).not.toBe(input);
    });

    it("leaves ordinary gh output unchanged", () => {
      const text = '{"number":1475,"title":"refactor(workflow): one helper"}';
      expect(redact(text)).toBe(text);
    });
  });

  describe.skipIf(process.platform === "win32")("capture", () => {
    let dir: string;
    const prevPath = process.env.PATH;

    afterEach(() => {
      process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    });

    it("runs the gh on PATH and stamps its output, exit code and command", () => {
      dir = mkdtempSync(join(tmpdir(), "capture-gh-"));
      // A stub gh: prints its argv, writes to stderr, exits 3.
      writeFileSync(
        join(dir, "gh"),
        '#!/bin/sh\necho "argv: $*"\necho "warn" >&2\nexit 3\n',
      );
      chmodSync(join(dir, "gh"), 0o755);
      process.env.PATH = `${dir}:${prevPath ?? ""}`;

      capture({ name: "probe", args: ["issue", "view", "7"] }, dir);

      const fixture = JSON.parse(
        readFileSync(join(dir, "probe.json"), "utf-8"),
      );
      expect(fixture).toMatchObject({
        command: "gh issue view 7 --repo sequant-io/sequant",
        args: ["issue", "view", "7"],
        exitCode: 3,
        stdout: "argv: issue view 7 --repo sequant-io/sequant\n",
        stderr: "warn\n",
        provenance: "captured",
      });
      expect(Date.parse(fixture.capturedAt)).not.toBeNaN();
    });

    it("redacts secret-shaped output before writing the fixture", () => {
      dir = mkdtempSync(join(tmpdir(), "capture-gh-"));
      const session = ["https://claude.ai/code/", "session_", "01AbCdEf"].join(
        "",
      );
      writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "body ${session}"\n`);
      chmodSync(join(dir, "gh"), 0o755);
      process.env.PATH = `${dir}:${prevPath ?? ""}`;

      capture({ name: "probe", args: ["pr", "view", "7"] }, dir);

      const raw = readFileSync(join(dir, "probe.json"), "utf-8");
      expect(raw).toContain("<session-redacted>");
      expect(raw).not.toContain("session_01AbCdEf");
    });
  });
});
