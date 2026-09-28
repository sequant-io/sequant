/**
 * Tests for the sequant_status tool's state-file wiring (#1164 AC-4).
 *
 * Production behavior must stay unchanged: with no override the tool builds a
 * StateManager on the default path and reconciles it. The `statePath` option
 * is the test-only redirect. Both collaborators are mocked, so this file never
 * reads or writes any `.sequant/state.json` and makes no GitHub call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const { constructed, reconcileStateMock } = vi.hoisted(() => ({
  constructed: [] as Array<{ options: unknown; instance: object }>,
  reconcileStateMock: vi.fn(),
}));

vi.mock("../../lib/workflow/state-manager.js", () => ({
  StateManager: class {
    constructor(options?: unknown) {
      constructed.push({ options, instance: this });
    }
    clearCache() {}
    async getIssueState() {
      return null;
    }
  },
}));

vi.mock("../../lib/workflow/reconcile.js", () => ({
  reconcileState: reconcileStateMock,
  getNextActionHint: vi.fn(),
}));

import { registerStatusTool } from "./status.js";
import { STATE_FILE_PATH } from "../../lib/workflow/state-schema.js";

type Handler = (args: { issue: number }) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function captureHandler(options?: { statePath?: string }): Handler {
  const registerTool = vi.fn();
  const server = { registerTool } as unknown as McpServer;
  registerStatusTool(server, options);
  expect(registerTool).toHaveBeenCalledTimes(1);
  expect(registerTool.mock.calls[0][0]).toBe("sequant_status");
  return registerTool.mock.calls[0][2] as Handler;
}

describe("sequant_status state path (#1164 AC-4)", () => {
  beforeEach(() => {
    constructed.length = 0;
    reconcileStateMock.mockReset();
    reconcileStateMock.mockResolvedValue({
      success: true,
      healed: [],
      warnings: [],
      lastSynced: "2026-01-01T00:00:00.000Z",
      githubReachable: true,
    });
  });

  it("uses the default StateManager path and reconciles it when no override is given", async () => {
    const handler = captureHandler();
    const result = await handler({ issue: 42 });

    expect(constructed).toHaveLength(1);
    const { options, instance } = constructed[0];
    const statePath = (options as { statePath?: string } | undefined)
      ?.statePath;
    expect(statePath).toBeUndefined();

    // The real StateManager resolves an unset statePath to the default file.
    const { StateManager: RealStateManager } = await vi.importActual<
      typeof import("../../lib/workflow/state-manager.js")
    >("../../lib/workflow/state-manager.js");
    expect(
      new RealStateManager(
        options as ConstructorParameters<typeof RealStateManager>[0],
      ).getStatePath(),
    ).toBe(STATE_FILE_PATH);

    // Reconcile stays on, against that same StateManager.
    expect(reconcileStateMock).toHaveBeenCalledTimes(1);
    expect(reconcileStateMock).toHaveBeenCalledWith({
      stateManager: instance,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("not_tracked");
  });

  it("uses the statePath override when one is given", async () => {
    const handler = captureHandler({ statePath: "/tmp/x/.sequant/state.json" });
    await handler({ issue: 42 });

    expect(constructed).toHaveLength(1);
    expect(constructed[0].options).toEqual({
      statePath: "/tmp/x/.sequant/state.json",
    });
    expect(reconcileStateMock).toHaveBeenCalledWith({
      stateManager: constructed[0].instance,
    });
  });
});
