# Probe: which SDK option drops claude.ai connectors from a phase agent (2026-10-16)

Resolves the lever question for #1396 (graph doc D-3) and the #1440 → #1396 edge (D-4).

**Method:** `probe-1396.mjs` calls the Agent SDK `query()` four times with the driver's relevant options (`settingSources: ["project"]`, `permissionMode: "bypassPermissions"`, one dynamic `mcpServers` entry), on the owner's account with claude.ai connectors. Each call is aborted when the `system/init` message arrives, so no model turn runs. The dynamic server is a placeholder process that isn't an MCP server, so it shows `failed`. That's expected: the probe checks which sources are listed, not whether they connect.

- Run 1: a scratch worktree of Dependabot PR #1445 (`@anthropic-ai/claude-agent-sdk` 0.3.296, bundled Claude Code 2.1.296).
- Run 2: `main` @ ad71b341 (SDK 0.3.289, bundled Claude Code 2.1.289).
- `cwd` was an empty scratch directory.

## Output, SDK 0.3.296 (CC 2.1.296)

```
== baseline (cc 2.1.296)
   probe                        failed      source=dynamic
   claude.ai Claude Docs        connected   source=claudeai
   claude.ai Gmail              connected   source=claudeai
   claude.ai Google Drive       needs-auth  source=claudeai
   claude.ai Google Calendar    needs-auth  source=claudeai
   claude.ai Figma              needs-auth  source=claudeai
== strictMcpConfig (cc 2.1.296)
   probe                        failed      source=dynamic
== disableClaudeAiConnectors (cc 2.1.296)
   probe                        failed      source=dynamic
== both (cc 2.1.296)
   probe                        failed      source=dynamic
```

## Output, SDK 0.3.289 (CC 2.1.289)

```
== baseline (cc 2.1.289)
   probe                        failed      source=dynamic
   claude.ai Claude Docs        connected   source=claudeai
   claude.ai Gmail              connected   source=claudeai
   claude.ai Google Drive       needs-auth  source=claudeai
   claude.ai Google Calendar    needs-auth  source=claudeai
   claude.ai Figma              needs-auth  source=claudeai
== strictMcpConfig (cc 2.1.289)
   probe                        failed      source=dynamic
== disableClaudeAiConnectors (cc 2.1.289)
   probe                        failed      source=dynamic
== both (cc 2.1.289)
   probe                        failed      source=dynamic
```

## Reading

- Both `strictMcpConfig: true` and `settings: { disableClaudeAiConnectors: true }` remove every `claudeai` server and keep the passed-in server, on both CLI versions.
- The lever doesn't depend on #1440's bump, so the two nodes have no edge (D-4).
- Not covered: whether a project `.mcp.json` server reaches a phase agent (the scratch `cwd` had none). That's outside #1396.

Also measured at plan time, on the #1445 tree: `npm ci` exit 0, `npx tsc --noEmit` exit 0.
