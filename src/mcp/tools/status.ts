/**
 * sequant_status MCP tool
 *
 * Get current workflow state for an issue.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StateManager } from "../../lib/workflow/state-manager.js";
import { isRunning } from "../run-registry.js";
import {
  reconcileState,
  getNextActionHint,
} from "../../lib/workflow/reconcile.js";

export function registerStatusTool(server: McpServer): void {
  server.registerTool(
    "sequant_status",
    {
      title: "Sequant Status",
      description:
        "Get the current workflow state, phase progress, and QA verdict for a tracked issue. " +
        "Reconciles with GitHub on every call for accurate status. " +
        "Returns isRunning: true when a sequant_run is actively executing. " +
        "Poll every 5-10 seconds during active runs for phase-level progress updates.",
      inputSchema: {
        issue: z.number().describe("GitHub issue number"),
      },
    },
    async ({ issue }) => {
      if (!issue || issue <= 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "INVALID_INPUT",
                message: "A valid issue number is required",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const stateManager = new StateManager();

        // Reconcile state with GitHub before reading
        const reconcileResult = await reconcileState({ stateManager });
        stateManager.clearCache();

        const issueState = await stateManager.getIssueState(issue);

        if (!issueState) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  issue,
                  status: "not_tracked",
                  isRunning: isRunning(issue),
                  lastSynced: reconcileResult.lastSynced,
                  githubReachable: reconcileResult.githubReachable,
                  message: `Issue #${issue} is not currently tracked in workflow state`,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                issue,
                title: issueState.title,
                status: issueState.status,
                isRunning: isRunning(issue),
                currentPhase: issueState.currentPhase,
                phases: issueState.phases,
                worktree: issueState.worktree,
                pr: issueState.pr,
                lastActivity: issueState.lastActivity,
                nextAction: getNextActionHint(issueState),
                lastSynced: reconcileResult.lastSynced,
                githubReachable: reconcileResult.githubReachable,
                warnings: reconcileResult.warnings
                  .filter((w) => w.issueNumber === issue)
                  .map((w) => w.description),
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "STATE_ERROR",
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
