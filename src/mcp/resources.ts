/**
 * MCP Resources for Sequant
 *
 * Exposes workflow state and configuration as readable resources.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import { StateManager } from "../lib/workflow/state-manager.js";
import { SETTINGS_PATH } from "../lib/settings.js";
import type { SkillsInstallStatus } from "../commands/version-preflight.js";

/**
 * Per-server context computed once at startup by `serve` (#988). `install` is
 * `null` when the project has no sequant manifest; `undefined` when the caller
 * did not compute it (tests, embedded use).
 */
export interface ResourceContext {
  install?: SkillsInstallStatus | null;
}

export function registerResources(
  server: McpServer,
  context: ResourceContext = {},
): void {
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
            Object.values(filteredIssues).map((v) => [String(v.number), v]),
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
        "Read this to understand how sequant_run will behave before invoking it. " +
        "Returned verbatim as written (JSON or JSONC). For whether the installed " +
        "skill tree is stale relative to this server, read sequant://install.",
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

  // sequant://install — skills-install status (#988). Server-computed data
  // lives here, deliberately apart from sequant://config, which is the user's
  // own settings file returned verbatim. Always an object: `{ installed:
  // false }` when the project has no sequant manifest, otherwise the status
  // computed once at startup. `filesModified: false` is the contract — the
  // server reports staleness and never applies it.
  server.registerResource(
    "install",
    "sequant://install",
    {
      description:
        "Whether the installed sequant skill tree (.claude/skills, hooks, agents) is " +
        "stale relative to this server's version, and the command that resolves it. " +
        "Report-only: the server never modifies project files.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "sequant://install",
          mimeType: "application/json",
          text: JSON.stringify(installResourceBody(context)),
        },
      ],
    }),
  );
}

export type InstallResourceBody =
  | { installed: false }
  | ({ installed: true } & SkillsInstallStatus);

function installResourceBody(context: ResourceContext): InstallResourceBody {
  return context.install
    ? { installed: true, ...context.install }
    : { installed: false };
}
