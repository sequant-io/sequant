# VS Code Extension for Workflow Visualization

The Sequant Explorer VS Code extension provides real-time workflow visualization directly in your IDE sidebar.

## Overview

Instead of switching to a browser-based dashboard, the VS Code extension shows issue status and workflow phases where you already work. It reads the same `.sequant/state.json` file used by the CLI.

## Features

### Tree View

The extension adds a Sequant panel to the Activity Bar showing:

- **Issues** sorted by status priority (in-progress first, then ready-for-merge, blocked, etc.)
- **Phases** as expandable children under each issue
- **Status icons** with color coding:
  - Blue spinning: in progress
  - Green check: ready for merge / completed
  - Yellow warning: blocked
  - Red X: abandoned / failed

### Actions

Right-click or use inline buttons on issues:

| Action | Description |
|--------|-------------|
| Open Worktree | Opens a terminal at the issue's worktree directory |
| Open on GitHub | Opens the issue in your browser |
| Refresh | Manually refresh the tree view |

### Auto-Refresh

The extension watches `.sequant/state.json` for changes and automatically updates the tree view when:
- A phase starts or completes
- Issue status changes
- New issues are added

## Installation

### From VSIX (Recommended)

1. Build the extension:
   ```bash
   cd vscode-extension
   npm install
   npm run compile
   npx vsce package
   ```

2. Install in VS Code:
   - Open Command Palette (Cmd+Shift+P)
   - Run "Extensions: Install from VSIX..."
   - Select the generated `.vsix` file

### For Development

1. Open `vscode-extension/` folder in VS Code
2. Press F5 to launch Extension Development Host
3. Open a workspace containing `.sequant/state.json`

## Activation

The extension activates automatically when:
- A workspace contains `.sequant/state.json`

No manual activation required.

## Spike Findings

This section documents the exploration results for issue #120.

### Effort Assessment

| Metric | Value |
|--------|-------|
| Lines of Code | ~500 LOC TypeScript |
| Files | 3 (package.json, extension.ts, tsconfig.json) |
| Dependencies | 0 runtime, 3 dev (@types/node, @types/vscode, typescript) |
| Build Time | ~2 seconds |

The implementation was straightforward using VS Code's built-in APIs.

### Limitations

1. **Tree-Only UI**: VS Code TreeDataProvider only supports hierarchical tree layouts. No grids, cards, or custom layouts without Webview panels.

2. **No Custom Styling**: Limited to VS Code's theme colors and built-in icons. Cannot match custom brand colors.

3. **Distribution**: Must be packaged as VSIX and installed manually, or published to VS Code Marketplace (requires publisher account).

4. **Single Workspace**: Shows state for the current workspace only. Cannot aggregate across multiple repositories.

5. **Read-Only**: Current implementation only displays state. Running phases would require terminal integration or task providers.

### UX Comparison: VS Code Extension vs Web Dashboard

| Aspect | VS Code Extension | Web Dashboard |
|--------|-------------------|---------------|
| **Context Switching** | None - in IDE | Must open browser |
| **Always Visible** | Yes - sidebar panel | No - separate tab |
| **Custom UI** | Limited (tree only) | Full flexibility |
| **Multi-Repo View** | No | Possible |
| **Installation** | VSIX per machine | URL (no install) |
| **Offline Access** | Yes | Local server needed |
| **Actions** | Open worktree, GitHub | Could be more interactive |
| **Filtering/Search** | Basic (VS Code tree filter) | Full search/filter UI |

### Recommendation

**Use the VS Code extension when:**
- Working on a single repository
- Prefer minimal context switching
- Want quick glance at status while coding

**Use the web dashboard when:**
- Need rich filtering/search
- Working across multiple repositories
- Want detailed analytics or history

Both options read the same state file, so they can be used together.

## Configuration

Currently no configuration options. Future enhancements could include:
- Custom refresh interval
- Filter by status
- Keyboard shortcuts for actions

## Troubleshooting

### Extension not activating

1. Verify `.sequant/state.json` exists in workspace root
2. Check VS Code's Extension Host logs (Help > Toggle Developer Tools)
3. Try manual refresh via Command Palette: "Sequant: Refresh"

### Tree view empty

1. Check that state.json contains issues
2. Verify JSON is valid: `cat .sequant/state.json | jq`
3. Check for errors in Developer Tools console

## Related

- [Workflow Phases](../concepts/workflow-phases.md)
- [State Command](../state-command.md)
- Issue #114 - Web Dashboard (Option A)
- Issue #120 - VS Code Extension (Option C)
