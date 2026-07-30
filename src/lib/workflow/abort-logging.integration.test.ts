/**
 * End-to-end integration tests for abort surfacing (#856, AC-4).
 *
 * The unit tests cover each half of the mechanism in isolation:
 * `ShutdownManager` produces an `AbortContext` and a 128+signum exit code,
 * and `LogWriter.finalize({ aborted })` writes an aborted record. Neither
 * proves the two are *wired together* — which is exactly what broke. The
 * original defect was not a bad function; it was `registerCleanup("Finalize
 * run logs", …)` calling `finalize()` with no argument, so a correct logger
 * and a correct shutdown manager still produced a log claiming success.
 *
 * These tests send a real signal to a real process that wires the two the way
 * `run-orchestrator.ts` does, then read the log off disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_WRITER_PATH = resolve(__dirname, "log-writer.ts");
const SHUTDOWN_PATH = resolve(__dirname, "../shutdown.ts");
const TSX_BIN = resolve(__dirname, "../../../node_modules/.bin/tsx");

interface WrittenLog {
  issues: Array<{
    issueNumber: number;
    status: string;
    aborted?: boolean;
    abortReason?: string;
    phases: unknown[];
  }>;
  summary: {
    passed: number;
    failed: number;
    aborted: number;
    totalIssues: number;
  };
  abortedBy?: string;
}

describe("abort surfacing end-to-end (#856 AC-4)", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "sequant-abort-int-"));
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  /**
   * Spawn a child that mirrors run-orchestrator.ts: create a LogWriter, start
   * an issue, register the "Finalize run logs" cleanup exactly as the
   * orchestrator does, then hold. Returns once the child reports READY.
   */
  async function spawnRunLike(): Promise<{
    child: ReturnType<typeof spawn>;
    pid: number;
  }> {
    // NOTE: `tsx --eval` compiles to CJS, so top-level await is unavailable —
    // everything async has to live inside an IIFE.
    const script = `
      import { LogWriter } from ${JSON.stringify(LOG_WRITER_PATH)};
      import { ShutdownManager } from ${JSON.stringify(SHUTDOWN_PATH)};

      (async () => {
        const writer = new LogWriter({ logPath: ${JSON.stringify(logDir)} });
        await writer.initialize({
          phases: ["spec", "exec", "qa"],
          sequential: false,
          qualityLoop: false,
          maxIterations: 3,
        });
        writer.startIssue(856, "Abort surfacing", []);

        const shutdown = new ShutdownManager();
        // Verbatim shape from run-orchestrator.ts.
        shutdown.registerCleanup("Finalize run logs", async (abort) => {
          await writer.finalize(abort ? { aborted: abort } : undefined);
        });

        process.stdout.write("READY pid=" + process.pid + "\\n");
        setInterval(() => {}, 1000);
      })();
    `;
    const child = spawn(TSX_BIN, ["--eval", script], {
      env: { ...process.env, SEQUANT_ORCHESTRATOR: "" },
    });
    let buf = "";
    child.stdout.on("data", (b) => (buf += b.toString()));
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));

    const pid = await new Promise<number>((res, rej) => {
      const t = setTimeout(
        () => rej(new Error(`child never reported READY. stderr: ${stderr}`)),
        15_000,
      );
      const i = setInterval(() => {
        const m = buf.match(/READY pid=(\d+)/);
        if (m) {
          clearInterval(i);
          clearTimeout(t);
          res(Number(m[1]));
        }
      }, 50);
    });
    return { child, pid };
  }

  function readOnlyLog(): WrittenLog {
    const files = readdirSync(logDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    return JSON.parse(readFileSync(join(logDir, files[0]), "utf-8"));
  }

  it(
    "a SIGTERM'd run writes an aborted log, not a successful one",
    { timeout: 30_000 },
    async () => {
      const { child, pid } = await spawnRunLike();

      const exitCode = await new Promise<number | null>((res) => {
        child.on("exit", (code) => res(code));
        process.kill(pid, "SIGTERM");
      });

      // AC-4: the run reports failure to its caller.
      expect(exitCode).toBe(143); // 128 + SIGTERM(15)

      // AC-4 + related defect 1: and the persisted log agrees.
      const log = readOnlyLog();
      expect(log.abortedBy).toBe("SIGTERM");
      expect(log.issues).toHaveLength(1);
      expect(log.issues[0].issueNumber).toBe(856);
      expect(log.issues[0].phases).toHaveLength(0);
      expect(log.issues[0].status).toBe("failure");
      expect(log.issues[0].aborted).toBe(true);
      expect(log.issues[0].abortReason).toContain("external SIGTERM");

      // The exact regression from the issue body: this run recorded
      // `summary.passed: 1` for zero completed phases.
      expect(log.summary.passed).toBe(0);
      expect(log.summary.failed).toBe(1);
      expect(log.summary.aborted).toBe(1);
    },
  );

  it("run-orchestrator's finalize cleanup actually forwards the abort context", () => {
    // The two tests above spawn a child that *reproduces* the orchestrator's
    // wiring, which proves the mechanism works but not that the orchestrator
    // still uses it. The realistic regression is someone editing
    // run-orchestrator.ts back to a bare `finalize()` — the original defect —
    // leaving both halves correct and the product broken again.
    //
    // Scoped deliberately to the registerCleanup block, not the whole file:
    // matching file-wide would let an unrelated comment mentioning "aborted"
    // satisfy the assertion.
    const source = readFileSync(
      resolve(__dirname, "run-orchestrator.ts"),
      "utf-8",
    );
    const block = source.match(
      /registerCleanup\(\s*"Finalize run logs",[\s\S]*?\n {6}\}\);/,
    );
    expect(block, "Finalize run logs cleanup block not found").not.toBeNull();

    const body = block![0];
    // The callback must accept the abort parameter...
    expect(body).toMatch(/async\s*\(\s*abort\s*\)\s*=>/);
    // ...and pass it into finalize, rather than calling finalize() bare.
    expect(body).toMatch(/finalize\(\s*abort\s*\?/);
  });

  it(
    "a SIGINT'd run is likewise recorded as aborted, with 130",
    { timeout: 30_000 },
    async () => {
      const { child, pid } = await spawnRunLike();

      const exitCode = await new Promise<number | null>((res) => {
        child.on("exit", (code) => res(code));
        process.kill(pid, "SIGINT");
      });

      expect(exitCode).toBe(130); // 128 + SIGINT(2)

      const log = readOnlyLog();
      expect(log.abortedBy).toBe("SIGINT");
      expect(log.issues[0].aborted).toBe(true);
      expect(log.issues[0].abortReason).toContain("user");
      expect(log.summary.passed).toBe(0);
    },
  );
});
