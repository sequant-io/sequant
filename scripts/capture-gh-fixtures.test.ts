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

import { CAPTURES, assertReadOnly, capture } from "./capture-gh-fixtures.js";
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
  ])("refuses the writing call %j", (args) => {
    expect(() => assertReadOnly(args)).toThrow(/refusing to capture/);
  });

  it.each([
    [["issue", "view", "1", "--json", "title"]],
    [["pr", "list", "--state", "open"]],
    [["api", "repos/o/r/commits/abc/check-runs", "-q", ".check_runs"]],
    [["auth", "status"]],
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
  });
});
