/**
 * MCP Resources for Sequant
 *
 * Exposes workflow state and configuration as readable resources.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import { STATE_FILE_PATH } from "../lib/workflow/state-schema.js";
import { SETTINGS_PATH } from "../lib/settings.js";

export function registerResources(server: McpServer): void {
  // sequant://state — current workflow state
  server.registerResource(
    "state",
    "sequant://state",
    {
      description: "Current Sequant workflow state (.sequant/state.json)",
      mimeType: "application/json",
    },
    async () => {
      try {
        if (!fs.existsSync(STATE_FILE_PATH)) {
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

        const content = fs.readFileSync(STATE_FILE_PATH, "utf-8");
        return {
          contents: [
            {
              uri: "sequant://state",
              mimeType: "application/json",
              text: content,
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
      description: "Current Sequant configuration (.sequant/settings.json)",
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
