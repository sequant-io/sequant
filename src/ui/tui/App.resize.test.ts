import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink";
import stringWidth from "string-width";
import { App } from "./App.js";
import type { RunSnapshot } from "../../lib/workflow/run-state.js";

/**
 * Width-reactivity regression test for the duplicate/garbled-frame bug.
 *
 * The corruption was a *width* failure: after the terminal shrank, ink kept
 * repainting boxes at the stale (now too-wide) width, so box lines wrapped and
 * the borders misaligned. `App` now tracks `columns` from the stdout `resize`
 * event, so this asserts the rendered box width follows a width decrease.
 */
// Mirrors ink-testing-library's fake stdout (non-interactive: ink writes full
// measurable frames) but with a *mutable* `columns` so we can simulate resize.
class FakeStdout extends EventEmitter {
  columns: number;
  rows = 40;
  frames: string[] = [];
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  write = (frame: string): void => {
    this.frames.push(frame);
  };
}

function snapshot(): RunSnapshot {
  return {
    config: { concurrency: 1, baseBranch: "main", qualityLoop: true },
    issues: [
      {
        number: 707,
        title: "a representative issue title that is reasonably long",
        branch: "feature/707-some-branch",
        status: "running",
        phases: [
          { name: "spec", status: "done", elapsedMs: 1000 },
          { name: "exec", status: "running" },
          { name: "qa", status: "pending" },
        ],
        currentPhase: {
          name: "exec",
          startedAt: new Date(0),
          lastActivityAt: new Date(0),
          nowLine: "running exec",
        },
        startedAt: new Date(0),
      },
    ],
    done: false,
    capturedAt: new Date(0),
  };
}

/** Max printable width across all lines of the most recent frame. */
function maxLineWidth(stdout: FakeStdout): number {
  const frame = stdout.frames.at(-1) ?? "";
  return Math.max(0, ...frame.split("\n").map((l) => stringWidth(l)));
}

/** Wait until ink has flushed at least one new frame (or time out). */
async function waitForFrame(stdout: FakeStdout): Promise<void> {
  const start = Date.now();
  const before = stdout.frames.length;
  while (stdout.frames.length === before && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("App width reactivity", () => {
  it("shrinks box width to fit after the terminal narrows", async () => {
    const stdout = new FakeStdout(120);
    const instance = render(
      createElement(App, { getSnapshot: () => snapshot() }),
      // `debug: true` makes ink write each frame synchronously as plain text
      // (no throttle / cursor codes) — the same mode ink-testing-library uses.
      { stdout: stdout as never, patchConsole: false, debug: true },
    );
    try {
      await waitForFrame(stdout);
      const wide = maxLineWidth(stdout);
      // Box is capped at 100 cols; at 120 columns it renders near that cap.
      expect(wide).toBeGreaterThan(80);
      expect(wide).toBeLessThanOrEqual(120);

      // Shrink the terminal and fire the resize the same way a real tty does.
      // Wait only briefly — under the 100 ms snapshot poll — so this asserts
      // the *resize event* drove the re-layout, not the periodic poll.
      stdout.columns = 60;
      stdout.emit("resize");
      await new Promise((r) => setTimeout(r, 60));

      const narrow = maxLineWidth(stdout);
      // The box must re-lay-out to fit the new width — never wider than the
      // terminal (the wrap that caused border misalignment).
      expect(narrow).toBeLessThanOrEqual(60);
      expect(narrow).toBeLessThan(wide);
    } finally {
      instance.unmount();
    }
  });
});
