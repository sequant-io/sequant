/**
 * #996 (#862 P1) AC-1 — the opencode hook shim.
 *
 * These tests spawn the **real** `.claude/hooks/pre-tool.sh`. A mocked hook
 * would make the force-push case assert the mock rather than the guard, which
 * is exactly how #830 shipped a green suite over a deleted fixture.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  GUARDED_TOOLS,
  PASSTHROUGH_TOOLS,
  SHIM_LOADED_SENTINEL,
  STRIPPED_ENV_VARS,
  SequantHookBlocked,
  buildHookEnv,
  decideFromHook,
  mapToolCall,
  resolveToolPath,
  runHook,
} from "../../../../templates/opencode/plugins/lib/sequant-hooks-core.js";
// The plugin entry is a separate module: opencode rejects a scanned plugin
// file that exports anything but functions, so it can hold no constants.
import { server } from "../../../../templates/opencode/plugins/sequant-hooks.js";

/** Repo root — the worktree this suite runs in, which owns `.claude/hooks/`. */
const PROJECT_DIR = process.cwd();

describe("862 P1 shim", () => {
  let worktree: string;

  beforeAll(() => {
    // The Edit/Write boundary guard reads $SEQUANT_WORKTREE and blocks
    // outright if the directory does not exist (pre-tool.sh:1488).
    worktree = mkdtempSync(join(tmpdir(), "sequant-shim-wt-"));
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "inside.ts"), "// inside\n");

    // A real repo with staged work: pre-tool.sh's commit guards legitimately
    // block an empty commit and a commit on main, so a fixture without these
    // would make the "conventional commit is allowed" case unreachable.
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: worktree, stdio: "pipe" });
    git("init", "-q", "-b", "feature/996-shim-fixture");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    git("add", "src/inside.ts");
  });

  afterAll(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  const ctx = () => ({
    directory: PROJECT_DIR,
    worktree,
    sessionID: "sess-996",
  });

  describe("AC-1: blocks on hook exit 2", () => {
    it("blocks a force push thrown by the shim", () => {
      const envelope = mapToolCall(
        "bash",
        { command: "git push --force origin main" },
        ctx(),
      );
      expect(envelope).not.toBeNull();

      expect(() => runHook(envelope!, ctx())).toThrow(SequantHookBlocked);
      expect(() => runHook(envelope!, ctx())).toThrow(/HOOK_BLOCKED/);
    });

    it("allows a conventional commit", () => {
      const envelope = mapToolCall(
        "bash",
        { command: 'git commit -m "fix(#996): a conventional message"' },
        ctx(),
      );
      expect(envelope).not.toBeNull();
      expect(() => runHook(envelope!, ctx())).not.toThrow();
    });
  });

  describe("AC-1: fails closed on a malformed args object", () => {
    it("blocks a bash call with no command field, without consulting the hook", () => {
      // The point of this case is that translation fails *before* any hook
      // spawn — mapToolCall is pure, so reaching it proves no fallthrough.
      expect(() => mapToolCall("bash", {}, ctx())).toThrow(SequantHookBlocked);
      expect(() => mapToolCall("bash", {}, ctx())).toThrow(/missing a usable "command"/);
    });

    it.each([
      ["null args", null],
      ["array args", []],
      ["string args", "git push --force"],
      ["numeric command", { command: 42 }],
      ["empty command", { command: "" }],
    ])("blocks %s", (_label, args) => {
      expect(() => mapToolCall("bash", args, ctx())).toThrow(SequantHookBlocked);
    });

    it("blocks an edit call with no filePath", () => {
      expect(() =>
        mapToolCall("edit", { oldString: "a", newString: "b" }, ctx()),
      ).toThrow(/missing a usable "filePath"/);
    });

    it("blocks an unrecognised tool rather than passing it through", () => {
      expect(() => mapToolCall("some_future_tool", {}, ctx())).toThrow(
        /unknown opencode tool/,
      );
    });
  });

  describe("AC-1: envelope translation (camelCase → snake_case)", () => {
    it("maps edit's filePath onto the file_path key pre-tool.sh reads", () => {
      const envelope = mapToolCall(
        "edit",
        { filePath: join(worktree, "src/inside.ts"), oldString: "a", newString: "b" },
        ctx(),
      );
      // Forwarding `args` verbatim would leave `.file_path` absent, the
      // guard's `if [[ -n "$FILE_PATH" ]]` block unentered, and pre-tool.sh
      // would fall through to exit 0 — a silent fail-open.
      expect(envelope!.tool_input).toHaveProperty("file_path");
      expect(envelope!.tool_input).not.toHaveProperty("filePath");
      expect(envelope!.tool_name).toBe("Edit");
    });

    it("blocks an edit whose file_path escapes the worktree", () => {
      vi.stubEnv("SEQUANT_WORKTREE", worktree);
      try {
        const outside = join(tmpdir(), "sequant-shim-outside.ts");
        const envelope = mapToolCall("write", { filePath: outside, content: "x" }, ctx());
        expect(() => runHook(envelope!, ctx())).toThrow(
          /must be within worktree/,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("allows an edit inside the worktree", () => {
      vi.stubEnv("SEQUANT_WORKTREE", worktree);
      try {
        const envelope = mapToolCall(
          "edit",
          { filePath: join(worktree, "src/inside.ts"), oldString: "a", newString: "b" },
          ctx(),
        );
        expect(() => runHook(envelope!, ctx())).not.toThrow();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("routes bash's workdir into the envelope cwd the guards evaluate", () => {
      const envelope = mapToolCall(
        "bash",
        { command: "ls", workdir: worktree },
        ctx(),
      );
      expect(envelope!.cwd).toBe(worktree);
    });

    it("defaults cwd to the worktree when no workdir is given", () => {
      const envelope = mapToolCall("bash", { command: "ls" }, ctx());
      expect(envelope!.cwd).toBe(worktree);
    });

    it("resolves a relative filePath against opencode's own base directory", () => {
      // opencode resolves `isAbsolute(p) ? p : join(directory, p)`; the hook
      // resolves against its own cwd. Normalising here keeps the worktree
      // prefix test comparing comparable paths.
      expect(resolveToolPath("src/a.ts", "/base")).toBe("/base/src/a.ts");
      expect(resolveToolPath("/abs/a.ts", "/base")).toBe("/abs/a.ts");
    });

    it("returns null for known passthrough tools without spawning the hook", () => {
      for (const tool of PASSTHROUGH_TOOLS) {
        expect(mapToolCall(tool, {}, ctx())).toBeNull();
      }
    });

    it("guards exactly the three tools pre-tool.sh dispatches on", () => {
      expect(GUARDED_TOOLS).toEqual({ bash: "Bash", edit: "Edit", write: "Write" });
    });

    it("never lists a file-mutating tool as passthrough", () => {
      for (const mutating of ["bash", "edit", "write", "patch", "apply_patch"]) {
        expect(PASSTHROUGH_TOOLS.has(mutating)).toBe(false);
      }
    });
  });

  describe("AC-1: exit-code contract", () => {
    it.each([
      [0, true],
      [1, true],
      [2, false],
    ])("maps exit %i to allow=%s", (code, allow) => {
      expect(decideFromHook(code as number, "").allow).toBe(allow);
    });

    it.each([3, 127, 255, null])(
      "blocks on the undocumented exit %s",
      (code) => {
        // Undefined behaviour in a security guard is a block, not an allow.
        expect(decideFromHook(code as number | null, "").allow).toBe(false);
      },
    );

    it("surfaces the hook's stderr as the block reason", () => {
      const decision = decideFromHook(2, "HOOK_BLOCKED: Force push\n");
      expect(decision.reason).toContain("HOOK_BLOCKED: Force push");
    });
  });

  describe("AC-1: env sanitisation", () => {
    it("strips the guard-disabling vars before spawning the hook", () => {
      const env = buildHookEnv(
        {
          CLAUDE_HOOKS_DISABLED: "true",
          CLAUDE_HOOKS_FILE_LOCKING: "false",
          PATH: "/usr/bin",
        },
        { directory: "/main", worktree: "/wt" },
      );
      for (const key of STRIPPED_ENV_VARS) {
        expect(env[key]).toBeUndefined();
      }
      expect(env.PATH).toBe("/usr/bin");
    });

    it("pins CLAUDE_PROJECT_DIR to the main checkout, not the worktree (#901)", () => {
      const env = buildHookEnv({}, { directory: "/main", worktree: "/wt" });
      expect(env.CLAUDE_PROJECT_DIR).toBe("/main");
    });

    it("still blocks a force push when CLAUDE_HOOKS_DISABLED is set ambiently", () => {
      vi.stubEnv("CLAUDE_HOOKS_DISABLED", "true");
      try {
        const envelope = mapToolCall(
          "bash",
          { command: "git push --force origin main" },
          ctx(),
        );
        // Without the strip, pre-tool.sh:9 would exit 0 and this would pass.
        expect(() => runHook(envelope!, ctx())).toThrow(/HOOK_BLOCKED/);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("AC-1: load handshake", () => {
    it("writes the sentinel to stderr when the plugin loads", async () => {
      // opencode silently ignores a plugin that throws at load (verified on
      // 1.18.27: exit 0, empty stderr, tools resolved), so file presence
      // proves nothing. The sentinel is the only evidence the shim is live.
      const writes: string[] = [];
      const spy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: unknown) => {
          writes.push(String(chunk));
          return true;
        });
      try {
        await server({ directory: PROJECT_DIR, worktree });
      } finally {
        spy.mockRestore();
      }
      expect(writes.join("")).toContain(SHIM_LOADED_SENTINEL);
    });

    it("exposes tool.execute.before with opencode's two-argument signature", async () => {
      const spy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      let hooks: Record<string, unknown>;
      try {
        hooks = (await server({ directory: PROJECT_DIR, worktree })) as Record<
          string,
          unknown
        >;
      } finally {
        spy.mockRestore();
      }
      const before = hooks["tool.execute.before"] as (
        i: unknown,
        o: unknown,
      ) => Promise<void>;
      expect(typeof before).toBe("function");
      expect(before.length).toBe(2);

      await expect(
        before(
          { tool: "bash", sessionID: "s", callID: "c" },
          { args: { command: "git push --force origin main" } },
        ),
      ).rejects.toThrow(/HOOK_BLOCKED/);
    });
  });

  describe("AC-1: missing hook script fails closed", () => {
    it("blocks when pre-tool.sh is absent from the project directory", () => {
      const empty = mkdtempSync(join(tmpdir(), "sequant-shim-nohook-"));
      try {
        const emptyCtx = { directory: empty, worktree: empty, sessionID: "s" };
        const envelope = mapToolCall("bash", { command: "ls" }, emptyCtx);
        expect(() => runHook(envelope!, emptyCtx)).toThrow(/not found under/);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });
});
