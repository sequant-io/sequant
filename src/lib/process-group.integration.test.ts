/**
 * #1472 AC-2: killProcessGroup against real detached children.
 *
 * Signals are counted by spying on `process.kill` while passing every call
 * through to the real one, so the children really receive them.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { killProcessGroup } from "./process-group.js";

function spawnDetached(script: string): ChildProcess {
  return spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
}

function closed(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve(child.signalCode);
      return;
    }
    child.on("close", (_code, signal) => resolve(signal));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Give bash time to run its `trap` builtin, so a TERM is really ignored. */
const trapInstalled = () => sleep(150);

describe.skipIf(process.platform === "win32")(
  "1472 process-group — killProcessGroup",
  () => {
    const children: ChildProcess[] = [];
    const track = (child: ChildProcess) => {
      children.push(child);
      return child;
    };

    afterEach(() => {
      vi.restoreAllMocks();
      for (const child of children.splice(0)) {
        if (child.exitCode == null && child.signalCode == null && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    });

    it("1472 AC-2 (a) escalates to SIGKILL after graceMs for a child that traps TERM", async () => {
      const child = track(spawnDetached("trap '' TERM; sleep 30 & wait"));
      await trapInstalled();

      const result = killProcessGroup(child, { graceMs: 200 });

      expect(result).toEqual({ requested: true });
      expect(await closed(child)).toBe("SIGKILL");
    });

    it("1472 AC-2 (b) a child that exits on SIGTERM gets no SIGKILL", async () => {
      const child = track(spawn("sleep", ["30"], { detached: true }));
      const kill = vi.spyOn(process, "kill");

      killProcessGroup(child, { graceMs: 200 });
      expect(await closed(child)).toBe("SIGTERM");
      await sleep(400);

      const signals = kill.mock.calls.map((call) => call[1]);
      expect(signals).toEqual(["SIGTERM"]);
    });

    it("1472 AC-2 (c) a child that already exited gets no signal", async () => {
      const child = track(spawn("true", [], { detached: true }));
      await closed(child);
      const kill = vi.spyOn(process, "kill");

      const result = killProcessGroup(child, { graceMs: 200 });
      await sleep(300);

      expect(result).toEqual({ requested: false });
      expect(kill).not.toHaveBeenCalled();
    });

    it("1472 AC-2 (d) two calls on one child send one SIGTERM", async () => {
      const child = track(spawn("sleep", ["30"], { detached: true }));
      const kill = vi.spyOn(process, "kill");

      const first = killProcessGroup(child, { graceMs: 200 });
      const second = killProcessGroup(child, { graceMs: 200 });
      await closed(child);
      await sleep(300);

      expect(first).toEqual({ requested: true });
      expect(second).toEqual({ requested: true });
      expect(kill.mock.calls.filter((c) => c[1] === "SIGTERM")).toHaveLength(1);
      expect(kill.mock.calls.filter((c) => c[1] === "SIGKILL")).toHaveLength(0);
    });

    it("1472 AC-2 does not escalate when graceMs is absent", async () => {
      const child = track(spawnDetached("trap '' TERM; sleep 30 & wait"));
      await trapInstalled();
      const kill = vi.spyOn(process, "kill");

      killProcessGroup(child);
      await sleep(400);

      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(kill.mock.calls.map((c) => c[1])).toEqual(["SIGTERM"]);
    });

    it("1472 AC-2 swallows ESRCH without a direct-kill fallback", () => {
      const esrch = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw esrch;
      });
      const child = { pid: 999_999, on: vi.fn() } as unknown as ChildProcess;

      expect(killProcessGroup(child)).toEqual({ requested: true });
      expect(kill.mock.calls).toEqual([[-999_999, "SIGTERM"]]);
    });

    it("1472 AC-2 falls back to a direct kill on a non-ESRCH error", () => {
      const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementationOnce(() => {
          throw eperm;
        })
        .mockImplementation(() => true);
      const child = { pid: 999_998, on: vi.fn() } as unknown as ChildProcess;

      killProcessGroup(child);

      expect(kill.mock.calls).toEqual([
        [-999_998, "SIGTERM"],
        [999_998, "SIGTERM"],
      ]);
    });

    it("1472 AC-2 returns requested false when the child has no pid", () => {
      const kill = vi.spyOn(process, "kill");
      const child = { pid: undefined, on: vi.fn() } as unknown as ChildProcess;

      expect(killProcessGroup(child)).toEqual({ requested: false });
      expect(kill).not.toHaveBeenCalled();
    });
  },
);
