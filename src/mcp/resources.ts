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
        "Also carries `skillsInstall` — whether the installed skill tree is stale " +
        "relative to this server's version. Reported only: the server never " +
        "rewrites project files; run `sequant update` to apply.",
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
                  ...installField(context),
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
              text: withInstallField(content, context),
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

  // sequant://install — skills-install status on its own (#988). The same
  // data rides on sequant://config, but settings files are allowed to be JSONC
  // and cannot always be re-serialized with an extra field; this resource is
  // the always-parseable channel.
  server.registerResource(
    "install",
    "sequant://install",
    {
      description:
        "Whether the installed sequant skill tree (.claude/skills, hooks, agents) is " +
        "stale relative to this server's version, and the command that resolves it. " +
        "Read-only: the server never modifies project files.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "sequant://install",
          mimeType: "application/json",
          text: JSON.stringify(installField(context).skillsInstall ?? null),
        },
      ],
    }),
  );
}

/** `{ skillsInstall }` when the caller computed it; `{}` otherwise. */
function installField(
  context: ResourceContext,
): { skillsInstall?: SkillsInstallStatus | null } {
  return context.install === undefined ? {} : { skillsInstall: context.install };
}

/**
 * Merge `skillsInstall` into the settings document when it is plain JSON. A
 * settings file with comments (JSONC) is returned verbatim — never rewritten
 * by hand — and the status stays available on sequant://install.
 */
function withInstallField(content: string, context: ResourceContext): string {
  const field = installField(context);
  if (!("skillsInstall" in field)) return content;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, ...field }, null, 2);
    }
    return content;
  } catch {
    return content;
  }
}
