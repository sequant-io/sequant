/**
 * MCP Resources for Sequant
 *
 * Exposes workflow state and configuration as readable resources.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import { StateManager } from "../lib/workflow/state-manager.js";
import { SETTINGS_PATH } from "../lib/settings.js";

export function registerResources(server: McpServer): void {
  // sequant://state — current workflow state
  server.registerResource(
    "state",
    "sequant://state",
    {
      description:
        "Dashboard view of all tracked GitHub issues and their workflow progress. " +
        "Contains per-issue phase status (spec/exec/qa), worktree paths, PR links, and QA verdicts. " +
        "Read this to understand which issues are in-flight before starting new work.",
      mimeType: "application/json",
    },
    async () => {
      try {
        const stateManager = new StateManager();
        if (!stateManager.stateExists()) {
          return {
            contents: [
              {
                uri: "sequant://state",
                mimeType: "application/json",
                text: JSON.stringify({ issues: {} }),
              },
            ],
          };
        }

        // Use getAllIssueStates() which applies TTL filtering
        const filteredIssues = await stateManager.getAllIssueStates();
        const state = await stateManager.getState();
        const output = {
          version: state.version,
          lastUpdated: state.lastUpdated,
          lastSynced: state.lastSynced,
          issues: Object.fromEntries(
            Object.entries(filteredIssues).map(([k, v]) => [
              String(v.number),
              v,
            ]),
          ),
        };
        return {
          contents: [
            {
              uri: "sequant://state",
              mimeType: "application/json",
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: "sequant://state",
              mimeType: "application/json",
              text: JSON.stringify({
                error: "Failed to read state",
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    },
  );

  // sequant://config — current Sequant configuration
  server.registerResource(
    "config",
    "sequant://config",
    {
      description:
        "Current Sequant workflow settings including default phases, timeout limits, " +
        "quality loop configuration, and agent preferences. " +
        "Read this to understand how sequant_run will behave before invoking it.",
      mimeType: "application/json",
    },
    async () => {
      try {
        if (!fs.existsSync(SETTINGS_PATH)) {
          return {
            contents: [
              {
                uri: "sequant://config",
                mimeType: "application/json",
                text: JSON.stringify({
                  message:
                    "No settings file found. Run `sequant init` to create one.",
                }),
              },
            ],
          };
        }

        const content = fs.readFileSync(SETTINGS_PATH, "utf-8");
        return {
          contents: [
            {
              uri: "sequant://config",
              mimeType: "application/json",
              text: content,
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: "sequant://config",
              mimeType: "application/json",
              text: JSON.stringify({
                error: "Failed to read config",
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    },
  );
}
