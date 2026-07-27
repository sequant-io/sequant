/**
 * Unit coverage for `sequant assess-render` (#823).
 *
 * Uses real temp files rather than a mocked `readFile`: the command is 60 lines
 * of read → parse → render → print, so mocking the read would leave the test
 * asserting little more than its own branching. Real files also exercise the
 * ENOENT / EISDIR distinction the error messages depend on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assessRenderCommand } from "./assess-render.js";

describe("assessRenderCommand", () => {
  let dir: string;
  let savedExitCode: typeof process.exitCode;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "assess-render-"));
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  /** Write `payload` to a temp file and return its path. */
  function fixture(name: string, payload: unknown): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
    return path;
  }

  const validBatch = {
    mode: "batch",
    commandPrefix: "npx sequant",
    issues: [
      {
        number: 823,
        action: "PROCEED",
        reason: "Render via CLI subcommand",
        run: "spec → exec → qa",
        phases: ["spec", "exec", "qa"],
        qualityLoop: true,
      },
    ],
    commands: [{ args: "run 823 -Q" }],
  };

  /** Concatenated stdout from the command. */
  function stdout(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join("\n");
  }

  /** Concatenated stderr from the command. */
  function stderr(): string {
    return errSpy.mock.calls.map((call) => String(call[0])).join("\n");
  }

  describe("happy path", () => {
    it("renders to stdout and leaves the exit code unset", async () => {
      await assessRenderCommand(fixture("ok.json", validBatch));

      expect(process.exitCode).toBeUndefined();
      expect(errSpy).not.toHaveBeenCalled();
      const out = stdout();
      expect(out).toContain("823");
      expect(out).toContain("PROCEED");
      expect(out).toContain("npx sequant run 823 -Q");
      expect(out).toContain("<!-- #823 assess:action=PROCEED");
    });

    it("writes nothing to stderr on success", async () => {
      await assessRenderCommand(fixture("ok.json", validBatch));
      expect(stderr()).toBe("");
    });
  });

  describe("unreadable input", () => {
    it("exits non-zero naming a missing file", async () => {
      await assessRenderCommand(join(dir, "absent.json"));

      expect(process.exitCode).toBe(1);
      expect(logSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain("cannot read");
      expect(stderr()).toContain("absent.json");
      expect(stderr()).toContain("ENOENT");
    });

    it("exits non-zero when handed a directory", async () => {
      await assessRenderCommand(dir);

      expect(process.exitCode).toBe(1);
      expect(stderr()).toContain("cannot read");
      expect(stderr()).toContain("EISDIR");
    });
  });

  describe("malformed JSON", () => {
    it("exits non-zero and distinguishes a parse failure from a schema failure", async () => {
      await assessRenderCommand(fixture("bad.json", "{not json"));

      expect(process.exitCode).toBe(1);
      expect(logSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain("is not valid JSON");
      // The read succeeded, so it must NOT be reported as unreadable.
      expect(stderr()).not.toContain("cannot read");
    });
  });

  describe("schema violations", () => {
    it("exits non-zero and names the offending field", async () => {
      const broken = {
        ...validBatch,
        issues: [{ ...validBatch.issues[0], action: "FROBNICATE" }],
      };
      await assessRenderCommand(fixture("schema.json", broken));

      expect(process.exitCode).toBe(1);
      expect(logSpy).not.toHaveBeenCalled();
      const err = stderr();
      expect(err).toContain("Invalid AssessResult");
      expect(err).toContain("issues[0].action");
      expect(err).toContain("PROCEED");
      expect(err).not.toContain("is not valid JSON");
    });

    it("names an unknown key rather than silently dropping it", async () => {
      const typo = {
        ...validBatch,
        issues: [{ ...validBatch.issues[0], reasonn: "typo" }],
      };
      await assessRenderCommand(fixture("typo.json", typo));

      expect(process.exitCode).toBe(1);
      expect(stderr()).toContain("reasonn");
    });

    it("reports a top-level violation with the file path", async () => {
      const path = fixture("empty.json", { mode: "batch" });
      await assessRenderCommand(path);

      expect(process.exitCode).toBe(1);
      expect(stderr()).toContain(path);
      expect(stderr()).toContain("issues");
    });
  });

  describe("output hygiene", () => {
    it("emits no ANSI escapes even when stdout is a TTY", async () => {
      const original = process.stdout.isTTY;
      try {
        process.stdout.isTTY = true;
        await assessRenderCommand(fixture("tty.json", validBatch));
        expect(stdout().includes(String.fromCharCode(27))).toBe(false);
      } finally {
        process.stdout.isTTY = original;
      }
    });

    it("prints the rendered block as a single console.log call", async () => {
      // The caller pastes stdout verbatim; chunking it would let a consumer
      // interleave other output into the middle of the block.
      await assessRenderCommand(fixture("single-call.json", validBatch));
      expect(logSpy).toHaveBeenCalledTimes(1);
    });
  });
});
